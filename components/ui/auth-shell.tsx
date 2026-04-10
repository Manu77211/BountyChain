"use client";

import { motion } from "framer-motion";
import { ReactNode } from "react";
import { PageIntro, Workspace } from "./primitives";

export function AuthShell({
  title,
  subtitle,
  children,
  sideNote,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  sideNote: ReactNode;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[linear-gradient(145deg,#0f274d_0%,#15386a_42%,#f0c020_160%)] py-0">
      <div className="pointer-events-none absolute -left-24 top-10 h-72 w-72 rounded-full bg-[#f0c020]/30 blur-3xl" />
      <div className="pointer-events-none absolute -right-16 bottom-10 h-72 w-72 rounded-full bg-[#d02020]/20 blur-3xl" />
      <Workspace className="relative z-10 flex min-h-screen items-center py-6">
        <div className="grid w-full gap-6 lg:grid-cols-[1.1fr_1fr]">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="space-y-6 border-2 border-[#121212] bg-[#f8f2dd] p-8 shadow-[8px_8px_0_#121212]"
          >
            <p className="text-xs font-black uppercase tracking-[0.22em] text-[#1040c0]">BountyEscrow AI</p>
            <PageIntro title={title} subtitle={subtitle} />
            <div className="rounded-none border border-[#121212] bg-white px-4 py-4 text-sm font-medium text-[#3f3f3f]">
              {sideNote}
            </div>
          </motion.div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 }}
            className="w-full"
          >
            {children}
          </motion.div>
        </div>
      </Workspace>
    </div>
  );
}
