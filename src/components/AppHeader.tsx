import { HexIcon } from "./Icons";

export function AppHeader({ current }: { current?: "home" | "jobs" | "swarm" }) {
  return (
    <header className="site-header app-header">
      <a className="brand" href="/" aria-label="HiveSAT home">
        <span className="brand-mark" aria-hidden="true"><HexIcon /></span>
        <span>HiveSAT</span>
      </a>
      <nav className="app-nav" aria-label="Primary navigation">
        <a className="app-nav-link" href="/" aria-current={current === "home" ? "page" : undefined}>
          Upload Instance
        </a>
        <a className="app-nav-link" href="/jobs" aria-current={current === "jobs" ? "page" : undefined}>
          My Jobs
        </a>
        <a className="app-nav-link app-nav-learn" href="/#how-it-works">How it works</a>
        <a className="swarm-nav-button" href={current === "swarm" ? "/" : "/swarm"}>
          <HexIcon />
          <span>{current === "swarm" ? "Exit Swarm Mode" : "Swarm Mode"}</span>
        </a>
      </nav>
    </header>
  );
}
