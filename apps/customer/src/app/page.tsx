import type { PublicBranchesResponse } from '@foot-repose/contracts';

/** Render per request: the branch directory is live data from the shared API. */
export const dynamic = 'force-dynamic';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';

async function fetchBranches(): Promise<PublicBranchesResponse['branches'] | null> {
  try {
    const response = await fetch(`${API_URL}/api/public/branches`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as PublicBranchesResponse;
    return body.branches;
  } catch {
    return null;
  }
}

export default async function CustomerHome() {
  const branches = await fetchBranches();

  return (
    <main className="wrap">
      <section className="hero">
        <h1>Foot Repose</h1>
        <p>
          Foot reflexology and massage across Muscat — walk in to any of our branches, or book
          ahead once online booking opens.
        </p>
        <span className="soon">Online booking arrives in Slice 2</span>
      </section>

      <section>
        <h2>Our branches</h2>
        {branches === null ? (
          <p className="notice">
            The branch directory is temporarily unavailable. Please call your nearest Foot Repose
            branch directly.
          </p>
        ) : (
          <ul className="grid">
            {branches.map((branch) => (
              <li key={branch.id} className="card">
                <span className="area">{branch.area}</span>
                <strong>{branch.name}</strong>
                <span className="muted">{branch.phone}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted">Open daily 10:00–22:00 · Asia/Muscat · prices in OMR</p>
    </main>
  );
}
