import { NextRequest, NextResponse } from "next/server";

type JwtPayload = {
  exp?: number;
  role?: string;
};

const protectedMatchers = [
  "/dashboard",
  "/bounties",
  "/submissions",
  "/disputes",
  "/profile",
  "/admin",
];

const HACKATHON_MODE = process.env.HACKATHON_MODE === "true";

function decodeJwtPayload(token?: string): JwtPayload | null {
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const json = atob(padded);
    return JSON.parse(json) as JwtPayload;
  } catch {
    return null;
  }
}

function isExpired(payload: JwtPayload | null) {
  if (!payload?.exp) {
    return true;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  return payload.exp <= nowSeconds;
}

function isProtectedPath(pathname: string) {
  return protectedMatchers.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function middleware(request: NextRequest) {
  if (HACKATHON_MODE) {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get("access_token")?.value;
  const payload = decodeJwtPayload(token);
  const authenticated = Boolean(token) && !isExpired(payload);

  if (pathname.startsWith("/admin")) {
    const role = String(payload?.role ?? "").toLowerCase();
    if (!authenticated || role !== "admin") {
      const target = request.nextUrl.clone();
      target.pathname = "/dashboard";
      target.search = "";
      return NextResponse.redirect(target);
    }
  }

  if (pathname === "/connect") {
    if (authenticated) {
      const target = request.nextUrl.clone();
      target.pathname = "/dashboard";
      target.search = "";
      return NextResponse.redirect(target);
    }
    return NextResponse.next();
  }

  if (isProtectedPath(pathname) && !authenticated) {
    const target = request.nextUrl.clone();
    target.pathname = "/connect";
    target.search = `?redirect=${encodeURIComponent(`${pathname}${search}`)}`;
    return NextResponse.redirect(target);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/bounties/:path*", "/submissions/:path*", "/disputes/:path*", "/profile", "/admin/:path*", "/connect"],
};
