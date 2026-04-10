"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GitPullRequest, MessageSquare, Plus, Scale, Trophy, User, LayoutDashboard, Layers } from "lucide-react";
import { useAuthStore } from "../../../store/auth-store";

export function MobileNav() {
  const pathname = usePathname();
  const { user } = useAuthStore();
  const role = String(user?.role ?? "").toLowerCase();
  const isFreelancer = role === "freelancer";

  const items = [
    { href: "/dashboard", icon: <LayoutDashboard size={18} />, label: "Dashboard" },
    { href: "/dashboard/projects", icon: <Layers size={18} />, label: "Applications" },
    { href: "/dashboard/chat", icon: <MessageSquare size={18} />, label: "Chats" },
    { href: isFreelancer ? "/bounties" : "/bounties/create", icon: isFreelancer ? <Trophy size={18} /> : <Plus size={18} />, label: isFreelancer ? "Bounties" : "Create" },
    {
      href: isFreelancer ? "/submissions" : "/disputes",
      icon: isFreelancer ? <GitPullRequest size={18} /> : <Scale size={18} />,
      label: isFreelancer ? "My Work" : "Disputes",
    },
    { href: "/profile", icon: <User size={18} />, label: "Profile" },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-surface-1/90 backdrop-blur md:hidden">
      <div className="grid grid-cols-6">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-1 py-2 text-[11px] ${
                active ? "text-brand-400" : "text-text-tertiary"
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
