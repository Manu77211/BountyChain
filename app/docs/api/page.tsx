import Link from "next/link";
import { API_ERROR_CATALOG } from "../../../lib/docs/api-error-catalog";

export const dynamic = "force-dynamic";

function toDomainCounts() {
  const counts = new Map<string, number>();
  for (const entry of API_ERROR_CATALOG) {
    counts.set(entry.domain, (counts.get(entry.domain) ?? 0) + 1);
  }

  return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

export default function ApiDocsPage() {
  const domainCounts = toDomainCounts();

  return (
    <main className="min-h-screen bg-[#f2f4f8] px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#4b4b4b]">API Docs</p>
          <h1 className="mt-2 text-3xl font-black uppercase tracking-tight text-[#121212]">
            Error Code Catalog
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-[#2d2d2d]">
            This catalog maps every unique backend error/status code to source files, message patterns,
            and debugging actions so troubleshooting is faster and deterministic.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link
              href="/docs/api/errors"
              className="border-2 border-[#121212] bg-[#1040c0] px-4 py-2 text-xs font-bold uppercase tracking-wide text-white shadow-[4px_4px_0_#121212]"
            >
              Browse All Codes
            </Link>
          </div>
        </section>

        <section className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
          <h2 className="text-lg font-black uppercase tracking-wide text-[#121212]">Error Envelope</h2>
          <p className="mt-2 text-sm text-[#2d2d2d]">
            API errors use a consistent shape. Some handlers return numeric HTTP code in code, while domain
            handlers return domain-specific codes in detail/messages.
          </p>
          <pre className="mt-3 overflow-x-auto border border-[#121212] bg-[#f7f7f7] p-3 text-xs text-[#121212]">
{`{
  "error": "string",
  "code": 400,
  "detail": "SC-C-004: Smart contract release_payout is not configured."
}`}
          </pre>
          <p className="mt-2 text-xs text-[#4b4b4b]">
            Core handlers: src/middleware/errorHandler.ts, src/middleware/globalErrorHandler.ts
          </p>
        </section>

        <section className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
          <h2 className="text-lg font-black uppercase tracking-wide text-[#121212]">Coverage Summary</h2>
          <p className="mt-2 text-sm text-[#2d2d2d]">
            Total unique codes documented: <span className="font-bold">{API_ERROR_CATALOG.length}</span>
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {domainCounts.map(([domain, count]) => (
              <div key={domain} className="border border-[#121212] bg-[#f9fbff] px-3 py-2 text-sm text-[#121212]">
                <span className="font-bold">{domain}</span>: {count}
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
