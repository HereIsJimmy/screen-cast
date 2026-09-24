import { exec } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison for the shutdown password. Hashing both sides to
 * a fixed length first means differing lengths don't leak anything either
 * (timingSafeEqual throws on mismatched buffer lengths otherwise).
 */
export function passwordsMatch(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function shutdownCommand(): string {
  switch (process.platform) {
    case "win32":
      // A few seconds' delay so the HTTP response has time to reach the
      // browser before the machine actually goes down.
      return "shutdown /s /t 5";
    case "darwin":
    case "linux":
      // Best-effort: this only works if the server process can run `sudo`
      // without a password prompt (e.g. a NOPASSWD sudoers entry for this
      // exact command) — there's no interactive terminal here to type one
      // into.
      return "sudo shutdown -h now";
    default:
      throw new Error(`Apagado no soportado en esta plataforma (${process.platform}).`);
  }
}

/**
 * Fire-and-forget: starts shutting down the PC the server is running on.
 * Throws synchronously (before running anything) if the platform isn't
 * supported, so the caller can still send an error response — everything
 * after that point is logged rather than thrown, since by the time the OS
 * command actually runs the HTTP response has normally already been sent.
 */
export function shutdownServerPc(): void {
  const command = shutdownCommand();
  console.warn(`[system] Apagando el PC del servidor ("${command}")…`);
  exec(command, (err) => {
    if (err) console.error("[system] El comando de apagado falló:", err.message);
  });
}
