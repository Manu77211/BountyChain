import Link from "next/link";
import { API_ERROR_CATALOG } from "../../../../lib/docs/api-error-catalog";

export const dynamic = "force-dynamic";

function severityClass(severity: "error" | "warning" | "info") {
  if (severity === "error") {
    return "bg-[#d92d20] text-white";
  }
  if (severity === "warning") {
    return "bg-[#b54708] text-white";
  }
  return "bg-[#175cd3] text-white";
}

export default function ApiErrorsPage() {
  const entries = [...API_ERROR_CATALOG].sort((a, b) => a.code.localeCompare(b.code));

  return (
    <main className="min-h-screen bg-[#f2f4f8] px-5 py-10 sm:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#4b4b4b]">/docs/api/errors</p>
              <h1 className="mt-2 text-3xl font-black uppercase tracking-tight text-[#121212]">All API Error Codes</h1>
              <p className="mt-2 text-sm text-[#2d2d2d]">
                Unique code mapping with source and debug notes.
              </p>
            </div>
            <Link
              href="/docs/api"
              className="border-2 border-[#121212] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide text-[#121212] shadow-[4px_4px_0_#121212]"
            >
              Back To API Docs
            </Link>
          </div>
        </section>

        <section className="space-y-4">
          {entries.map((entry) => (
            <article key={entry.code} className="border-2 border-[#121212] bg-white p-5 shadow-[6px_6px_0_#121212]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="border border-[#121212] bg-[#111827] px-2 py-1 text-xs font-black uppercase tracking-wide text-white">
                  {entry.code}
                </span>
                <span className="border border-[#121212] bg-[#f0f2f5] px-2 py-1 text-xs font-bold uppercase tracking-wide text-[#121212]">
                  {entry.domain}
                </span>
                <span className={`border border-[#121212] px-2 py-1 text-xs font-bold uppercase tracking-wide ${severityClass(entry.severity)}`}>
                  {entry.severity}
                </span>
              </div>

              <p className="mt-3 text-sm font-semibold text-[#121212]">{entry.summary}</p>

              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <div>
                  <h2 className="text-xs font-black uppercase tracking-wide text-[#4b4b4b]">Messages</h2>
                  <ul className="mt-2 space-y-1 text-sm text-[#2d2d2d]">
                    {entry.messages.map((message) => (
                      <li key={`${entry.code}-${message}`}>- {message}</li>
                    ))}
                  </ul>
                </div>

                <div>
                  <h2 className="text-xs font-black uppercase tracking-wide text-[#4b4b4b]">Source Files</h2>
                  <ul className="mt-2 space-y-1 text-sm text-[#2d2d2d]">
                    {entry.sources.map((source) => (
                      <li key={`${entry.code}-${source}`}>- {source}</li>
                    ))}
                  </ul>
                </div>

                <div>
                  <h2 className="text-xs font-black uppercase tracking-wide text-[#4b4b4b]">Debug Checklist</h2>
                  <ul className="mt-2 space-y-1 text-sm text-[#2d2d2d]">
                    {entry.debug.map((tip) => (
                      <li key={`${entry.code}-${tip}`}>- {tip}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}
