import type { DiscordCustodyBinding } from "../../deploy/discord-alert-secret.ts";
export const discord: DiscordCustodyBinding = Object.freeze({ enabled: false, release: "a".repeat(40), commitment: "d".repeat(64) });

export const observer = Object.freeze({ enabled: false, stage: "prod" as const, release: discord.release, commitment: "e".repeat(64) });
