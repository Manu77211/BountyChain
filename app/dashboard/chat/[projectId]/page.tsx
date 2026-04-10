"use client";

import { io, type Socket } from "socket.io-client";
import Image from "next/image";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  listProjectConversationsRequest,
  listProjectMessagesRequest,
  type ProjectConversation,
  type ProjectMessage,
  SOCKET_BASE_URL,
} from "../../../../lib/api";
import { useAuthStore } from "../../../../store/auth-store";
import { Button, Card, PageIntro, Textarea } from "../../../../components/ui/primitives";

type JoinAck = { ok: boolean; message?: string };
type SendAck = { ok: boolean; message?: string };

type SelectedAttachment = {
  dataUrl: string;
  name: string;
  size: number;
  type: string;
};

function toDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Unable to read selected file"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export default function DashboardChatPage() {
  const params = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const projectId = params.projectId ?? "";
  const applicationId = searchParams.get("applicationId")?.trim() || "";

  const { token, user, hydrate } = useAuthStore();
  const [conversations, setConversations] = useState<ProjectConversation[]>([]);
  const [messages, setMessages] = useState<ProjectMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [attachment, setAttachment] = useState<SelectedAttachment | null>(null);
  const [sending, setSending] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const conversationScope = applicationId ? "APPLICATION" : "BOUNTY";

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [messages],
  );

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    async function loadConversations() {
      if (!token) {
        return;
      }

      try {
        const data = await listProjectConversationsRequest(token);
        setConversations(data ?? []);
      } catch {
        setConversations([]);
      }
    }

    void loadConversations();
  }, [token]);

  useEffect(() => {
    if (!bottomRef.current) {
      return;
    }
    bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [sortedMessages]);

  useEffect(() => {
    const authToken = token;
    const activeProjectId = projectId;

    if (!authToken || !activeProjectId) {
      return;
    }
    const resolvedToken: string = authToken;
    const resolvedProjectId: string = activeProjectId;

    async function loadHistory() {
      setLoading(true);
      setError(null);
      try {
        const data = await listProjectMessagesRequest(resolvedToken, resolvedProjectId, {
          applicationId: applicationId || undefined,
        });
        setMessages(data);
      } catch (requestError) {
        setError((requestError as Error).message);
      } finally {
        setLoading(false);
      }
    }

    void loadHistory();
  }, [applicationId, projectId, token]);

  useEffect(() => {
    const authToken = token;
    const activeProjectId = projectId;

    if (!authToken || !activeProjectId) {
      return;
    }
    const resolvedToken: string = authToken;
    const resolvedProjectId: string = activeProjectId;

    const socket = io(SOCKET_BASE_URL, {
      auth: { token: resolvedToken },
      transports: ["websocket"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit(
        "project:join",
        {
          projectId: resolvedProjectId,
          applicationId: applicationId || undefined,
        },
        (ack: JoinAck) => {
          if (!ack.ok) {
            setError(ack.message ?? "Failed to join conversation");
          }
        },
      );
    });

    socket.on("project:message:new", (message: ProjectMessage) => {
      if (message.projectId !== resolvedProjectId) {
        return;
      }

      if (conversationScope === "APPLICATION") {
        if (String(message.scope).toUpperCase() !== "APPLICATION") {
          return;
        }
        if ((message.applicationId ?? "") !== applicationId) {
          return;
        }
      } else if (String(message.scope).toUpperCase() !== "BOUNTY") {
        return;
      }

      setMessages((current) => {
        if (current.some((item) => item.id === message.id)) {
          return current;
        }
        return [...current, message];
      });
    });

    socket.on("connect_error", () => {
      setError("Unable to connect to live chat socket");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [applicationId, conversationScope, projectId, token]);

  async function onSelectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (file.size > 1_500_000) {
      setError("File size must be less than 1.5 MB for in-chat upload.");
      return;
    }

    try {
      const dataUrl = await toDataUrl(file);
      setAttachment({
        dataUrl,
        name: file.name,
        size: file.size,
        type: file.type,
      });
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }

  function isImageAttachment(message: ProjectMessage) {
    const type = String(message.attachment?.type ?? "").toLowerCase();
    if (type.startsWith("image/")) {
      return true;
    }

    const url = String(message.fileUrl ?? "").toLowerCase();
    return url.startsWith("data:image/") || /\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/.test(url);
  }

  function conversationHref(item: ProjectConversation) {
    if (!item.applicationId) {
      return `/dashboard/chat/${item.projectId}`;
    }
    return `/dashboard/chat/${item.projectId}?applicationId=${item.applicationId}`;
  }

  function initials(value: string) {
    const words = value.trim().split(/\s+/).slice(0, 2);
    return words.map((word) => word.charAt(0).toUpperCase()).join("") || "C";
  }

  function profileHref(item: ProjectConversation | null) {
    if (!item?.counterpartId) {
      return null;
    }
    return `/dashboard/users/${item.counterpartId}`;
  }

  const activeConversation = useMemo(
    () =>
      conversations.find(
        (item) => item.projectId === projectId && (item.applicationId ?? "") === applicationId,
      ) ?? null,
    [applicationId, conversations, projectId],
  );

  async function onSendMessage(event: FormEvent) {
    event.preventDefault();

    if (!socketRef.current || !projectId) {
      return;
    }

    const text = content.trim();
    const filePayloadUrl = attachment?.dataUrl ?? "";

    if (!text && !filePayloadUrl) {
      return;
    }

    setSending(true);
    setError(null);

    socketRef.current.emit(
      "project:message:send",
      {
        projectId,
        applicationId: applicationId || undefined,
        content: text || "Shared an attachment",
        fileUrl: filePayloadUrl || undefined,
        fileName: attachment?.name,
        fileSize: attachment?.size,
        fileType: attachment?.type,
      },
      (ack: SendAck) => {
        setSending(false);
        if (!ack.ok) {
          setError(ack.message ?? "Failed to send message");
          return;
        }

        setContent("");
        setAttachment(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = "";
        }
      },
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageIntro
          title={conversationScope === "APPLICATION" ? "Applicant Conversation" : "Bounty Conversation"}
          subtitle="Real-time messaging with thread-level context and file sharing."
        />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" className="h-8 px-3 text-xs">
            <Link href="/dashboard/chat">All Conversations</Link>
          </Button>
          <Button asChild variant="secondary" className="h-8 px-3 text-xs">
            <Link href={`/dashboard/projects/${projectId}`}>Bounty Workspace</Link>
          </Button>
        </div>
      </div>

      {error ? <p className="text-sm text-[#8f1515]">{error}</p> : null}

      <Card className="p-0">
        <div className="grid min-h-[74vh] gap-0 md:grid-cols-[320px_1fr]">
          <div className="border-b-2 border-[#121212] bg-[#f6f8fc] md:border-b-0 md:border-r-2">
            <div className="border-b border-[#121212] p-3 text-xs font-semibold text-[#4b4b4b]">
              Conversations
            </div>
            <div className="max-h-[30vh] overflow-y-auto md:max-h-[calc(74vh-41px)]">
              {conversations.map((item) => {
                const active = item.projectId === projectId && (item.applicationId ?? "") === applicationId;
                return (
                  <Link
                    key={item.id}
                    href={conversationHref(item)}
                    className={`block border-b border-[#d6dbe5] px-3 py-3 ${
                      active ? "bg-white" : "hover:bg-[#eef3ff]"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#121212] bg-[#fff3cd] text-xs font-bold">
                        {initials(item.counterpartName ?? item.title)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[#121212]">{item.title}</p>
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
            </div>
          </div>

          <div className="flex min-h-0 flex-col bg-[linear-gradient(180deg,#f8fbff_0%,#ecf2ff_100%)]">
            <div className="border-b border-[#121212] bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#121212] bg-[#fff3cd] text-xs font-bold">
                    {initials(activeConversation?.counterpartName ?? activeConversation?.title ?? "Chat")}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[#121212]">
                      {activeConversation?.title ?? `Project ${projectId.slice(0, 8)}`}
                    </p>
                    <p className="text-xs text-[#4b4b4b]">
                      {activeConversation?.counterpartName
                        ? `With ${activeConversation.counterpartName}${activeConversation.counterpartRole ? ` (${activeConversation.counterpartRole})` : ""}`
                        : conversationScope === "APPLICATION"
                          ? "Private client-applicant thread"
                          : "Main bounty thread"}
                    </p>
                  </div>
                </div>

                {profileHref(activeConversation) ? (
                  <Button asChild variant="secondary" className="h-8 px-3 text-xs">
                    <Link href={profileHref(activeConversation) ?? "#"}>View Profile</Link>
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {loading ? <p className="text-sm text-[#4b4b4b]">Loading message history...</p> : null}

              {!loading && sortedMessages.length === 0 ? (
                <p className="text-sm text-[#4b4b4b]">No messages yet. Start the conversation.</p>
              ) : null}

              {sortedMessages.map((message) => {
                const mine = user?.id === message.senderId;
                return (
                  <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl border px-3 py-2 shadow-sm ${
                        mine
                          ? "border-[#66a33f] bg-[#dcf8c6]"
                          : "border-[#cfd7e5] bg-white"
                      }`}
                    >
                      {!mine ? (
                        <p className="mb-1 text-[11px] font-semibold text-[#1040c0]">
                          {message.sender.name}
                        </p>
                      ) : null}

                      <p className="whitespace-pre-wrap text-sm text-[#121212]">{message.content}</p>

                      {message.fileUrl ? (
                        <div className="mt-2 space-y-2">
                          {isImageAttachment(message) ? (
                            <a href={message.fileUrl} target="_blank" rel="noreferrer" className="block">
                              <Image
                                src={message.fileUrl}
                                alt={message.attachment?.name ?? "attachment"}
                                width={640}
                                height={360}
                                className="max-h-56 rounded-lg border border-[#121212] object-contain"
                              />
                            </a>
                          ) : null}
                          <a
                            href={message.fileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-block rounded-lg border border-[#121212] bg-[#f8f8f8] px-2 py-1 text-xs text-[#1040c0] underline"
                          >
                            {message.attachment?.name || "Open attachment"}
                            {message.attachment?.size ? ` (${formatBytes(message.attachment.size)})` : ""}
                          </a>
                        </div>
                      ) : null}

                      <div className="mt-1 text-right text-[11px] text-[#4b4b4b]">
                        {new Date(message.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                );
              })}

              <div ref={bottomRef} />
            </div>

            <form onSubmit={onSendMessage} className="border-t border-[#121212] bg-white p-3">
              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={onSelectFile}
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="h-10 w-10 px-0"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach file"
                >
                  +
                </Button>
                <Textarea
                  rows={2}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Type a message"
                  maxLength={5000}
                />
                <Button type="submit" className="h-10" disabled={sending || (!content.trim() && !attachment)}>
                  {sending ? "Sending..." : "Send"}
                </Button>
              </div>

              {attachment ? (
                <div className="mt-2 flex items-center justify-between rounded-lg border border-[#121212] bg-[#f5f5f5] px-2 py-1 text-xs">
                  <span>{attachment.name} ({formatBytes(attachment.size)})</span>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setAttachment(null);
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </form>
          </div>
        </div>
      </Card>
    </section>
  );
}
