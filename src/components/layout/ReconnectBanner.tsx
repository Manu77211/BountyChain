"use client";

import { Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useSocketStore } from "../../../store/socket-store";

export function ReconnectBanner() {
  const { reconnecting } = useSocketStore();

  return (
    <AnimatePresence>
      {reconnecting ? (
        <motion.div
          initial={{ y: -48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -48, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="sticky top-0 z-[70] border-b border-[#e0a800] bg-[#fff4d1]"
        >
          <div className="mx-auto flex h-10 max-w-7xl items-center justify-center gap-2 px-4 text-sm font-semibold text-[#7a5400]">
            <span>Connection lost - reconnecting...</span>
            <Loader2 size={14} className="animate-spin" />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
