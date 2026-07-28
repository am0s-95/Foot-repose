import { notFound } from 'next/navigation';
import type { BranchCatalogResponse } from '@foot-repose/contracts';

/** Render per request: prices/durations are live, dated catalog data. */
export const dynamic = 'force-dynamic';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';

type CatalogResult = BranchCatalogResponse | 'not-found' | 'error';

async function fetchCatalog(branchId: string): Promise<CatalogResult> {
  try {
    const response = await fetch(`${API_URL}/api/public/branches/${branchId}/services`, {
      cache: 'no-store',
    });
    if (response.status === 404) return 'not-found';
    if (!response.ok) return 'error';
    return (await response.json()) as BranchCatalogResponse;
  } catch {
    return 'error';
  }
}

export default async function BranchServicesPage({
  params,
}: {
  params: Promise<{ branchId: string }>;
}) {
  const { branchId } = await params;
  const catalog = await fetchCatalog(branchId);
  if (catalog === 'not-found') notFound();

  if (catalog === 'error') {
    return (
      <main className="wrap">
        <a className="back" href="/">
          ← All branches
        </a>
        <p className="notice">
          The service list is temporarily unavailable. Please call the branch directly.
        </p>
      </main>
    );
  }

  return (
    <main className="wrap">
      <a className="back" href="/">
        ← All branches
      </a>
      <section className="hero compact">
        <h1>{catalog.branch.name}</h1>
        <p>
          {catalog.branch.area} · {catalog.branch.phone}
        </p>
      </section>

      <section>
        <h2>Services & prices</h2>
        {catalog.services.length === 0 ? (
          <p className="notice">No services are published for this branch yet.</p>
        ) : (
          <ul className="service-list">
            {catalog.services.map((service) => (
              <li key={service.serviceId} className="service-row">
                <div>
                  <strong>{service.name}</strong>
                  <span className="muted">{service.durationMin} min</span>
                </div>
                <strong className="price">{service.priceFormatted}</strong>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="muted">Prices in Omani rials (OMR) · effective {catalog.date} (Asia/Muscat)</p>
    </main>
  );
}
