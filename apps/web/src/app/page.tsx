"use client";

/**
 * The front door: straight to Markets. Discovery first — what exists, what
 * it trades at, and where the Index stands — with no execution on this page.
 */

import { MarketsDiscovery } from "@/components/markets/discovery";

export default function HomePage() {
  return <MarketsDiscovery />;
}
