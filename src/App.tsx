import { useSyncExternalStore } from "react";
import HomePage from "./pages/HomePage";
import JobPage from "./pages/JobPage";
import JobsPage from "./pages/JobsPage";
import SwarmPage from "./pages/SwarmPage";
import { AppHeader } from "./components/AppHeader";

type Route =
  | { name: "home" }
  | { name: "job"; jobId: string }
  | { name: "jobs" }
  | { name: "swarm" }
  | { name: "not-found" };

function subscribeToLocation(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

function getPathname(): string {
  return window.location.pathname;
}

function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchRoute(pathname: string): Route {
  if (pathname === "/") return { name: "home" };
  if (pathname === "/jobs" || pathname === "/jobs/") return { name: "jobs" };
  if (pathname === "/swarm" || pathname === "/swarm/") return { name: "swarm" };

  const jobMatch = pathname.match(/^\/jobs\/([^/]+)\/?$/);
  if (jobMatch) {
    return { name: "job", jobId: decodeRouteSegment(jobMatch[1]) };
  }

  return { name: "not-found" };
}

function RoutePlaceholder({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="route-shell">
      <AppHeader />
      <main className="route-placeholder">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <div className="route-placeholder-copy">{children}</div>
        <a className="secondary-button route-home-link" href="/">Return home</a>
      </main>
    </div>
  );
}

function App() {
  const pathname = useSyncExternalStore(
    subscribeToLocation,
    getPathname,
    () => "/",
  );
  const route = matchRoute(pathname);

  if (route.name === "home") return <HomePage />;

  if (route.name === "swarm") {
    return <SwarmPage />;
  }

  if (route.name === "jobs") return <JobsPage />;

  if (route.name === "job") {
    return <JobPage key={route.jobId} jobId={route.jobId} />;
  }

  return (
    <RoutePlaceholder eyebrow="404" title="Page not found">
      <p>The requested HiveSAT page does not exist.</p>
    </RoutePlaceholder>
  );
}

export default App;
