const MODULES = [
  { name: 'Branches', detail: 'Open, close and configure the 11 branches', slice: 'Slice 3' },
  { name: 'Employees & roles', detail: 'Accounts, branch assignment, permissions', slice: 'Slice 3' },
  { name: 'Services & pricing', detail: 'Catalogue and OMR price management', slice: 'Slice 3' },
  { name: 'Reports', detail: 'Occupancy, revenue and no-show rates', slice: 'Slice 4' },
  { name: 'Audit trail', detail: 'Every login and booking change, by actor', slice: 'Slice 4' },
];

export default function AdminHome() {
  return (
    <main className="wrap">
      <div className="brand">
        <span className="brand-mark">FR</span>
        <div>
          <strong>Foot Repose — Admin console</strong>
          <span className="brand-sub">Head office · 11 branches · Asia/Muscat</span>
        </div>
      </div>
      <p className="muted">
        The admin console ships after the branch vertical slice. The modules below are planned and
        will reuse the same shared API, permissions and audit log that the Branch App already runs
        on — nothing here is mocked.
      </p>
      <ul className="grid">
        {MODULES.map((module) => (
          <li key={module.name} className="card">
            <span className="tag">{module.slice}</span>
            <strong>{module.name}</strong>
            <span className="muted">{module.detail}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
