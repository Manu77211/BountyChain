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
    <div className="min-h-screen bg-[#f0f0f0] py-10">
      <Workspace>
        <div className="grid gap-8 lg:grid-cols-[1.05fr_1fr]">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="space-y-6 border-2 border-[#121212] bg-white p-8 shadow-[6px_6px_0_#121212]"
          >
            <PageIntro title={title} subtitle={subtitle} />
            <div className="text-sm font-medium text-[#3f3f3f]">{sideNote}</div>
          </motion.div>
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.08 }}>
            {children}
          </motion.div>
        </div>
      </Workspace>
    </div>
  );
}
