"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { listProjectConversationsRequest, type ProjectConversation } from "../../../lib/api";
import { useAuthStore } from "../../../store/auth-store";
import { Button, Card, Input, PageIntro, Pill } from "../../../components/ui/primitives";

function conversationHref(item: ProjectConversation) {
  if (!item.applicationId) {
    return `/dashboard/chat/${item.projectId}`;
  }
  return `/dashboard/chat/${item.projectId}?applicationId=${item.applicationId}`;
}

export default function DashboardChatInboxPage() {
  const { token, hydrate } = useAuthStore();

  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ProjectConversation[]>([]);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    async function load() {
      if (!token) {
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const response = await listProjectConversationsRequest(token);
        setItems(response ?? []);
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [token]);

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) {
      return items;
    }

    return items.filter((item) => {
      const haystack = [
        item.title,
        item.counterpartName ?? "",
        item.lastMessage?.content ?? "",
        item.scope,
        item.status,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(text);
    });
  }, [items, query]);

  const selectedConversation = useMemo(() => filtered[0] ?? null, [filtered]);

  function displayTime(value?: string | null) {
    if (!value) {
      return "";
    }
    return new Date(value).toLocaleString();
  }

  function initials(value: string) {
    const words = value.trim().split(/\s+/).slice(0, 2);
    return words.map((word) => word.charAt(0).toUpperCase()).join("") || "C";
  }

  function profileHref(item: ProjectConversation) {
    if (!item.counterpartId) {
      return null;
    }
    return `/dashboard/users/${item.counterpartId}`;
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageIntro
          title="Conversations"
          subtitle="All bounty and applicant threads in one messaging inbox."
        />
        <Button asChild variant="secondary" className="h-8 px-3 text-xs">
          <Link href="/dashboard/bounties">Open Bounties</Link>
        </Button>
      </div>

      <Card className="p-0">
        <div className="grid min-h-[68vh] gap-0 md:grid-cols-[320px_1fr]">
          <div className="border-b-2 border-[#121212] bg-[#f5f7fb] md:border-b-0 md:border-r-2">
            <div className="border-b border-[#121212] p-3">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by bounty, person, or message"
              />
            </div>

            <div className="max-h-[58vh] overflow-y-auto md:max-h-[calc(68vh-64px)]">
              {filtered.map((item) => {
                const lastAt = item.lastMessage?.createdAt ?? item.updatedAt;
                return (
                  <Link
                    key={item.id}
                    href={conversationHref(item)}
                    className="block w-full border-b border-[#d6dbe5] bg-transparent px-3 py-3 text-left transition hover:bg-[#eef3ff]"
                  >
                    <div className="flex items-start gap-2">
                      <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#121212] bg-[#fff3cd] text-xs font-bold">
                        {initials(item.counterpartName ?? item.title)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="truncate text-sm font-semibold text-[#121212]">{item.title}</p>
                          <span className="shrink-0 text-[11px] text-[#4b4b4b]">{displayTime(lastAt)}</span>
                        </div>
                        <p className="truncate text-xs text-[#4b4b4b]">
                          {item.counterpartName
                            ? `With ${item.counterpartName}${item.counterpartRole ? ` (${item.counterpartRole})` : ""}`
                            : "Main bounty room"}
                        </p>
                        <p className="mt-1 truncate text-xs text-[#5b5b5b]">
                          {item.lastMessage?.content ?? "No messages yet"}
                        </p>
                      </div>
                    </div>
                  </Link>
                );
              })}

              {!loading && filtered.length === 0 ? (
                <p className="p-3 text-sm text-[#4b4b4b]">No conversations found for this filter.</p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col">
            {selectedConversation ? (
              <>
                <div className="border-b border-[#121212] bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-lg font-semibold text-[#121212]">{selectedConversation.title}</p>
                      <p className="text-xs text-[#4b4b4b]">
                        {selectedConversation.counterpartName
                          ? `With ${selectedConversation.counterpartName}${selectedConversation.counterpartRole ? ` (${selectedConversation.counterpartRole})` : ""}`
                          : "Main bounty delivery conversation"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {profileHref(selectedConversation) ? (
                        <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                          <Link href={profileHref(selectedConversation) ?? "#"}>View Profile</Link>
                        </Button>
                      ) : null}
                      <Pill text={selectedConversation.scope} />
                      <Pill text={selectedConversation.status} />
                    </div>
                  </div>
                </div>

                <div className="flex-1 bg-[linear-gradient(180deg,#f8fbff_0%,#eef3ff_100%)] p-4">
                  <div className="rounded-xl border border-[#121212] bg-white p-4">
                    <p className="text-xs text-[#4b4b4b]">Last message</p>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-[#121212]">
                      {selectedConversation.lastMessage?.content ?? "No messages yet."}
                    </p>
                    <p className="mt-2 text-xs text-[#4b4b4b]">
                      {selectedConversation.lastMessage?.createdAt
                        ? `${selectedConversation.lastMessage.senderName} • ${displayTime(selectedConversation.lastMessage.createdAt)}`
                        : `Updated ${displayTime(selectedConversation.updatedAt)}`}
                    </p>
                  </div>
                </div>

                <div className="border-t border-[#121212] bg-white p-3">
                  <Button asChild className="h-9 px-4 text-xs">
                    <Link href={conversationHref(selectedConversation)}>Open Thread</Link>
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-sm text-[#4b4b4b]">
                Select a conversation to preview.
              </div>
            )}
          </div>
        </div>
      </Card>

      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}
      {loading ? <p className="text-sm text-[#4b4b4b]">Loading conversations...</p> : null}
    </section>
  );
}
