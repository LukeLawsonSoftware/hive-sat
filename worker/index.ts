import {
  JOB_LIFETIME_MS,
  MAX_COMPRESSED_FORMULA_BYTES,
  MAX_ENCODED_FORMULA_BYTES,
  type CreateJobInput,
  type FormulaDeclaration,
  formulaObjectKey,
} from "./contracts";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../shared/public-jobs";
import { hmacSha256Hex, randomToken, sha256Hex } from "./crypto";
import { JobCoordinatorDO } from "./job-coordinator";
import { SwarmDirectoryDO } from "./swarm-directory";
import { ResultVerifierDO } from "./result-verifier";
import { MAX_SAT_MODEL_ARTIFACT_BYTES } from "../shared/result-manifest";

export { JobCoordinatorDO, ResultVerifierDO, SwarmDirectoryDO };

const API_PREFIX = "/api/";
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SMALL_JSON_LIMIT = 8 * 1024;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function isEnabled(value: string): boolean {
  return value === "true";
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function apiError(error: ApiError): Response {
  return json(
    { error: { code: error.code, message: error.message, ...error.details } },
    { status: error.status },
  );
}

async function readSmallJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > SMALL_JSON_LIMIT) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "The JSON request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > SMALL_JSON_LIMIT) {
    throw new ApiError(413, "REQUEST_TOO_LARGE", "The JSON request body is too large.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function parseFormula(value: unknown): FormulaDeclaration {
  if (!isRecord(value)) throw new ApiError(400, "INVALID_FORMULA", "Formula metadata is required.");
  const declaration = {
    hash: value.hash,
    variableCount: value.variableCount,
    clauseCount: value.clauseCount,
    literalCount: value.literalCount,
    encodedBytes: value.encodedBytes,
    compressedBytes: value.compressedBytes,
  };
  if (
    typeof declaration.hash !== "string" ||
    !SHA256_PATTERN.test(declaration.hash) ||
    !positiveInteger(declaration.variableCount, 0xffff_ffff) ||
    !positiveInteger(declaration.clauseCount, 0xffff_ffff) ||
    !positiveInteger(declaration.literalCount, 2_000_000) ||
    !positiveInteger(declaration.encodedBytes, MAX_ENCODED_FORMULA_BYTES) ||
    !positiveInteger(declaration.compressedBytes, MAX_COMPRESSED_FORMULA_BYTES) ||
    declaration.encodedBytes < 20 ||
    declaration.compressedBytes < 1
  ) {
    throw new ApiError(400, "INVALID_FORMULA", "Formula metadata is invalid or exceeds platform limits.");
  }
  const expectedEncodedBytes = 20 + (declaration.literalCount + declaration.clauseCount) * 4;
  if (declaration.encodedBytes !== expectedEncodedBytes) {
    throw new ApiError(400, "INVALID_FORMULA", "HiveCnfV1 byte length does not match its metadata.");
  }
  return declaration as FormulaDeclaration;
}

function parseCreateJob(value: unknown): CreateJobInput {
  if (!isRecord(value)) throw new ApiError(400, "INVALID_REQUEST", "Job metadata is required.");
  if (value.protocolVersion !== PUBLIC_JOB_PROTOCOL_VERSION) {
    throw new ApiError(426, "UPGRADE_REQUIRED", "This client protocol version is not supported.");
  }
  if (value.publicConsent !== true) {
    throw new ApiError(
      400,
      "PUBLIC_CONSENT_REQUIRED",
      "You must explicitly consent to sharing this formula with public swarm participants.",
    );
  }
  if (typeof value.deviceId !== "string" || !DEVICE_ID_PATTERN.test(value.deviceId)) {
    throw new ApiError(400, "INVALID_DEVICE_ID", "A valid anonymous device ID is required.");
  }
  if (typeof value.turnstileToken !== "string" || value.turnstileToken.length < 1 || value.turnstileToken.length > 2048) {
    throw new ApiError(400, "INVALID_TURNSTILE_TOKEN", "A valid Turnstile token is required.");
  }
  return {
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    deviceId: value.deviceId,
    turnstileToken: value.turnstileToken,
    publicConsent: true,
    formula: parseFormula(value.formula),
  };
}

async function validateTurnstile(token: string, remoteIp: string, env: Env): Promise<void> {
  const secret = requiredString(env.TURNSTILE_SECRET, "TURNSTILE_SECRET");
  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);
  body.set("remoteip", remoteIp);
  body.set("idempotency_key", crypto.randomUUID());
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new ApiError(503, "TURNSTILE_UNAVAILABLE", "Turnstile validation is temporarily unavailable.");
  }
  const result = await response.json<{ success?: boolean }>();
  if (result.success !== true) {
    throw new ApiError(403, "TURNSTILE_REJECTED", "Turnstile validation failed. Please try a new challenge.");
  }
}

function jobStub(env: Env, jobId: string) {
  return requiredBinding(env.JOB_COORDINATORS, "JOB_COORDINATORS").getByName(jobId);
}

function directoryStub(env: Env) {
  return requiredBinding(env.SWARM_DIRECTORY, "SWARM_DIRECTORY").getByName("global-v1");
}

function requiredBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new ApiError(503, "BINDING_MISCONFIGURED", `${name} is not configured.`);
  return value;
}

function requiredString(value: string | undefined, name: string): string {
  if (!value) throw new ApiError(503, "SECRET_MISCONFIGURED", `${name} is not configured.`);
  return value;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/u);
  if (!match) throw new ApiError(401, "AUTHORIZATION_REQUIRED", "A bearer token is required.");
  return match[1];
}

async function requireKnownJob(env: Env, jobId: string): Promise<void> {
  if (!await directoryStub(env).known(jobId)) {
    throw new ApiError(404, "JOB_NOT_FOUND", "The job does not exist or has expired.");
  }
}

async function createJob(request: Request, env: Env): Promise<Response> {
  if (!isEnabled(env.FEATURE_PUBLIC_JOBS)) {
    throw new ApiError(503, "PUBLIC_JOBS_DISABLED", "Public job submission is currently disabled.");
  }
  const input = parseCreateJob(await readSmallJson(request));
  const remoteIp = request.headers.get("cf-connecting-ip") ?? "unknown";
  await validateTurnstile(input.turnstileToken, remoteIp, env);

  const [deviceDigest, networkDigest] = await Promise.all([
    sha256Hex(input.deviceId),
    hmacSha256Hex(requiredString(env.NETWORK_DIGEST_KEY, "NETWORK_DIGEST_KEY"), remoteIp),
  ]);
  const jobId = randomToken(24);
  const ownerToken = randomToken();
  const uploadToken = randomToken();
  const [ownerDigest, uploadDigest] = await Promise.all([
    sha256Hex(ownerToken),
    sha256Hex(uploadToken),
  ]);
  const createdAt = Date.now();
  const expiresAt = createdAt + JOB_LIFETIME_MS;
  const globalCeiling = Number.parseInt(env.MAX_ACTIVE_JOBS, 10);
  if (!Number.isSafeInteger(globalCeiling) || globalCeiling < 1) {
    throw new ApiError(503, "ADMISSION_MISCONFIGURED", "Public job admission is not configured.");
  }

  const directory = directoryStub(env);
  const admission = await directory.admit({
    jobId,
    deviceDigest,
    networkDigest,
    createdAt,
    expiresAt,
    globalCeiling,
  });
  if (!admission.ok) {
    const status = admission.code === "GLOBAL_JOB_LIMIT" ? 503 : 429;
    const messages = {
      ACTIVE_JOB_LIMIT: "This device or network already has an active public job.",
      CREATION_RATE_LIMIT: "This device or network has reached the rolling daily creation limit.",
      GLOBAL_JOB_LIMIT: "HiveSAT has reached its active public-job capacity.",
    } as const;
    throw new ApiError(status, admission.code, messages[admission.code],
      admission.retryAt ? { retryAt: admission.retryAt } : undefined);
  }

  try {
    await jobStub(env, jobId).initialize({
      jobId,
      ownerDigest,
      uploadDigest,
      formula: input.formula,
      createdAt,
      expiresAt,
      objectKey: formulaObjectKey(jobId),
    });
  } catch (error) {
    await directory.rollback(jobId);
    throw error;
  }

  const origin = new URL(request.url).origin;
  return json({
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    jobId,
    ownerToken,
    uploadToken,
    expiresAt,
    uploadUrl: `${origin}/api/v1/jobs/${jobId}/formula`,
    publicUrl: `${origin}/jobs/${jobId}`,
    ownerUrl: `${origin}/jobs/${jobId}#owner=${encodeURIComponent(ownerToken)}`,
  }, { status: 201 });
}

async function uploadFormula(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!isEnabled(env.FEATURE_PUBLIC_JOBS)) {
    throw new ApiError(503, "PUBLIC_JOBS_DISABLED", "Public job submission is currently disabled.");
  }
  const uploadDigest = await sha256Hex(bearerToken(request));
  const coordinator = jobStub(env, jobId);
  const authorization = await coordinator.authorizeUpload(uploadDigest);
  if (!authorization.ok) {
    const status = authorization.code === "INVALID_TOKEN" ? 403 : authorization.code === "NOT_FOUND" ? 404 : 409;
    throw new ApiError(status, authorization.code, "Formula upload is not authorized for this job.");
  }
  const contentLength = Number(
    request.headers.get("content-length") ??
    request.headers.get("x-hivesat-content-length") ??
    "NaN",
  );
  if (!Number.isSafeInteger(contentLength) || contentLength !== authorization.compressedBytes) {
    throw new ApiError(400, "CONTENT_LENGTH_MISMATCH", "Content-Length must match the declared compressed size.");
  }
  if (!request.body || contentLength > MAX_COMPRESSED_FORMULA_BYTES) {
    throw new ApiError(400, "INVALID_FORMULA_BODY", "A bounded gzip formula body is required.");
  }

  const formulas = requiredBinding(env.FORMULAS, "FORMULAS");
  const stored = await formulas.put(authorization.objectKey, request.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/vnd.hivesat.cnf+gzip" },
    customMetadata: { formulaHash: authorization.formulaHash, jobId },
  });
  if (!stored) throw new ApiError(409, "FORMULA_ALREADY_UPLOADED", "A formula already exists for this job.");
  if (stored.size !== authorization.compressedBytes) {
    await formulas.delete(authorization.objectKey);
    throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The uploaded formula size did not match its declaration.");
  }
  const completed = await coordinator.completeUpload(uploadDigest, stored.size);
  if (!completed.ok) {
    await formulas.delete(authorization.objectKey);
    throw new ApiError(409, completed.code, "The job could not accept the completed upload.");
  }
  await directoryStub(env).markReady(jobId);
  return json({ jobId, state: "QUEUED", formulaHash: authorization.formulaHash }, { status: 201 });
}

async function getStatus(env: Env, jobId: string): Promise<Response> {
  const status = await jobStub(env, jobId).getStatus();
  if (!status) throw new ApiError(404, "JOB_NOT_FOUND", "The job does not exist or has expired.");
  return json(status);
}

async function downloadFormula(env: Env, jobId: string): Promise<Response> {
  const status = await jobStub(env, jobId).getStatus();
  if (!status || ["UPLOADING", "CANCELLED", "INVALID"].includes(status.state)) {
    throw new ApiError(404, "FORMULA_NOT_FOUND", "The public formula is not available.");
  }
  const object = await requiredBinding(env.FORMULAS, "FORMULAS").get(formulaObjectKey(jobId));
  if (!object?.body) throw new ApiError(404, "FORMULA_NOT_FOUND", "The public formula is not available.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=300, immutable");
  headers.set("x-hivesat-formula-sha256", status.formula.hash);
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

async function uploadSatModel(
  request: Request,
  env: Env,
  jobId: string,
  leaseId: string,
): Promise<Response> {
  if (bearerToken(request) !== leaseId) {
    throw new ApiError(403, "INVALID_TOKEN", "The model upload token does not match this lease.");
  }
  const coordinator = jobStub(env, jobId);
  const authorization = await coordinator.authorizeModelUpload(leaseId);
  if (!authorization.ok) {
    throw new ApiError(
      authorization.code === "NOT_FOUND" ? 404 : 409,
      authorization.code,
      "This lease cannot upload a SAT model.",
    );
  }
  const contentLength = Number(
    request.headers.get("content-length") ??
    request.headers.get("x-hivesat-content-length") ??
    "NaN",
  );
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 12 ||
    contentLength > authorization.maximumBytes ||
    contentLength > MAX_SAT_MODEL_ARTIFACT_BYTES ||
    !request.body
  ) {
    throw new ApiError(400, "INVALID_MODEL_BODY", "A bounded SAT model body with Content-Length is required.");
  }
  const stored = await requiredBinding(env.FORMULAS, "FORMULAS").put(
    authorization.objectKey,
    request.body,
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/vnd.hivesat.model" },
      customMetadata: {
        jobId,
        taskId: authorization.task.taskId,
        formulaHash: authorization.formulaHash,
      },
    },
  );
  if (!stored) throw new ApiError(409, "MODEL_ALREADY_UPLOADED", "This lease already uploaded a model.");
  if (stored.size !== contentLength) {
    await requiredBinding(env.FORMULAS, "FORMULAS").delete(authorization.objectKey);
    throw new ApiError(400, "UPLOAD_SIZE_MISMATCH", "The model size changed while streaming.");
  }
  return json({ jobId, taskId: authorization.task.taskId, leaseId, bytes: stored.size }, { status: 201 });
}

async function cancelJob(request: Request, env: Env, jobId: string): Promise<Response> {
  const ownerDigest = await sha256Hex(bearerToken(request));
  const result = await jobStub(env, jobId).cancel(ownerDigest);
  if (!result.ok) {
    throw new ApiError(result.code === "NOT_FOUND" ? 404 : 403, result.code, "Job cancellation is not authorized.");
  }
  await requiredBinding(env.FORMULAS, "FORMULAS").delete(result.objectKey);
  await directoryStub(env).close(jobId);
  return json({ jobId, state: "CANCELLED", changed: result.changed });
}

async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/v1/health") {
    const directory = await directoryStub(env).snapshot();
    return json({
      ok: true,
      environment: env.ENVIRONMENT,
      features: {
        publicJobs: isEnabled(env.FEATURE_PUBLIC_JOBS),
        publicSwarm: isEnabled(env.FEATURE_PUBLIC_SWARM),
      },
      turnstileSiteKey: env.TURNSTILE_SITE_KEY,
      activeJobs: directory.activeJobs,
      activeWorkers: directory.activeWorkers,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/v1/jobs") return createJob(request, env);
  if (url.pathname === "/api/v1/swarm/socket") {
    if (!isEnabled(env.FEATURE_PUBLIC_SWARM)) {
      throw new ApiError(503, "PUBLIC_SWARM_DISABLED", "Public swarm assignment is currently disabled.");
    }
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "WEBSOCKET_REQUIRED", "Expected Upgrade: websocket.");
    }
    return directoryStub(env).fetch(request);
  }

  const modelMatch = url.pathname.match(
    /^\/api\/v1\/jobs\/([^/]+)\/results\/([^/]+)\/model$/u,
  );
  if (modelMatch) {
    const [, jobId, leaseId] = modelMatch;
    if (!JOB_ID_PATTERN.test(jobId)) throw new ApiError(404, "JOB_NOT_FOUND", "The job was not found.");
    await requireKnownJob(env, jobId);
    if (request.method === "PUT") return uploadSatModel(request, env, jobId, leaseId);
  }

  const match = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(formula|cancel|socket))?$/u);
  if (match) {
    const jobId = match[1];
    if (!JOB_ID_PATTERN.test(jobId)) throw new ApiError(404, "JOB_NOT_FOUND", "The job was not found.");
    await requireKnownJob(env, jobId);
    const action = match[2];
    if (request.method === "GET" && !action) return getStatus(env, jobId);
    if (request.method === "GET" && action === "socket") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new ApiError(426, "WEBSOCKET_REQUIRED", "Expected Upgrade: websocket.");
      }
      return jobStub(env, jobId).fetch(request);
    }
    if (request.method === "PUT" && action === "formula") return uploadFormula(request, env, jobId);
    if (request.method === "GET" && action === "formula") return downloadFormula(env, jobId);
    if (request.method === "POST" && action === "cancel") return cancelJob(request, env, jobId);
  }
  throw new ApiError(404, "NOT_FOUND", "API route not found");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(API_PREFIX)) return env.ASSETS.fetch(request);

    let response: Response;
    try {
      response = await handleApiRequest(request, env);
    } catch (error) {
      if (error instanceof ApiError) response = apiError(error);
      else {
        console.error(JSON.stringify({ event: "api.error", path: url.pathname, error: String(error) }));
        response = apiError(new ApiError(500, "INTERNAL_ERROR", "The request could not be completed."));
      }
    }
    console.log(JSON.stringify({
      event: "api.request",
      method: request.method,
      path: url.pathname,
      status: response.status,
    }));
    return response;
  },
} satisfies ExportedHandler<Env>;
