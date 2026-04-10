export function truncateAddress(value?: string | null, left = 6, right = 4) {
  if (!value) {
    return "Not connected";
  }
  if (value.length <= left + right + 3) {
    return value;
  }
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

export function getPageTitle(pathname: string) {
  if (pathname.startsWith("/dashboard/freelancers")) {
    return "Freelancers";
  }
  if (pathname.startsWith("/dashboard/projects")) {
    return "Applications";
  }
  if (pathname.startsWith("/dashboard/chat")) {
    return "Conversations";
  }
  if (pathname.startsWith("/dashboard/bounties")) {
    return "Bounties";
  }
  if (pathname.startsWith("/dashboard/profile")) {
    return "Profile";
  }
  if (pathname.startsWith("/dashboard/wallet")) {
    return "Wallet";
  }
  if (pathname.startsWith("/dashboard/notifications")) {
    return "Notifications";
  }
  if (pathname.startsWith("/disputes")) {
    return "Disputes";
  }
  if (pathname.startsWith("/submissions")) {
    return "Submissions";
  }
  return "Dashboard";
}
