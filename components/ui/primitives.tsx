"use client";

import { motion } from "framer-motion";
import { ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost";

export function Button({
  children,
  className = "",
  variant = "primary",
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  asChild?: boolean;
}) {
  const styles: Record<ButtonVariant, string> = {
    primary:
      "border-2 border-[#121212] bg-[#1040c0] text-white shadow-[4px_4px_0_#121212] hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[6px_6px_0_#121212]",
    secondary:
      "border-2 border-[#121212] bg-white text-[#121212] shadow-[4px_4px_0_#121212] hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[6px_6px_0_#121212]",
    ghost: "border-2 border-[#121212] bg-[#f0c020] text-[#121212] hover:brightness-95",
  };

  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      {...props}
      className={`inline-flex items-center justify-center rounded-none px-4 py-2.5 text-sm font-bold uppercase tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-60 ${styles[variant]} ${className}`}
    >
      {children}
    </Comp>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-none border-2 border-[#121212] bg-white p-6 shadow-[6px_6px_0_#121212] ${className}`}
    >
      {children}
    </div>
  );
}

export function Workspace({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-7xl px-5 sm:px-8 md:px-12 ${className}`}>{children}</div>;
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-none border-2 border-[#121212] bg-white px-3 py-2.5 text-sm text-[#121212] placeholder:text-[#575757] outline-none transition focus:border-[#1040c0] focus:ring-2 focus:ring-[#1040c0]/20 ${props.className ?? ""}`}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-none border-2 border-[#121212] bg-white px-3 py-2.5 text-sm text-[#121212] placeholder:text-[#575757] outline-none transition focus:border-[#1040c0] focus:ring-2 focus:ring-[#1040c0]/20 ${props.className ?? ""}`}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`w-full rounded-none border-2 border-[#121212] bg-white px-3 py-2.5 text-sm text-[#121212] outline-none transition focus:border-[#1040c0] focus:ring-2 focus:ring-[#1040c0]/20 ${props.className ?? ""}`}
    />
  );
}

export function Pill({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center border border-[#121212] bg-[#f0c020] px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-[#121212]">{text}</span>
  );
}

export function PageIntro({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <h1 className="text-4xl font-black uppercase tracking-tight text-[#121212]">{title}</h1>
      <p className="mt-3 max-w-2xl text-sm font-medium text-[#3f3f3f]">{subtitle}</p>
    </motion.div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const safeValue = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className="h-3 w-full overflow-hidden border border-[#121212] bg-[#f5f5f5]">
      <div
        className="h-full bg-[linear-gradient(90deg,#1040c0,#d02020)] transition-all"
        style={{ width: `${safeValue}%` }}
      />
    </div>
  );
}

export function Dialog({ children, ...props }: DialogPrimitive.DialogProps & { children: ReactNode }) {
  return <DialogPrimitive.Root {...props}>{children}</DialogPrimitive.Root>;
}

export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({ children }: { children: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
      <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[95vw] max-w-xl -translate-x-1/2 -translate-y-1/2 border-2 border-[#121212] bg-[#f0f0f0] p-6 shadow-[8px_8px_0_#121212]">
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 border border-[#121212] bg-white p-1.5 text-[#121212] hover:bg-[#f5f5f5]" aria-label="Close">
          <X size={16} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ children }: { children: ReactNode }) {
  return <div className="mb-4 space-y-1">{children}</div>;
}

export const DialogTitle = DialogPrimitive.Title;

export const DialogDescription = DialogPrimitive.Description;
