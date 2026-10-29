import { ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE, adminToken, checkAdminPassword } from "@/lib/server/auth";

// Sign in to the "Daily email report" card (newplan.md step 5): POST { password } sets the
// httpOnly admin cookie for 30 days; DELETE signs out.

function cookieHeader(request: Request, value: string, maxAge: number): string {
  // Secure everywhere except plain-HTTP local testing (browsers treat localhost as secure anyway).
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export async function POST(request: Request) {
  if (!process.env.ADMIN_PASSWORD) return Response.json({ error: "ADMIN_PASSWORD is not set on the server" }, { status: 503 });
  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    // Treated as a wrong password.
  }
  if (!password || !checkAdminPassword(password)) {
    // Slows down guessing.
    await new Promise((r) => setTimeout(r, 750));
    return Response.json({ error: "Wrong password" }, { status: 401 });
  }
  return Response.json({ ok: true }, { headers: { "set-cookie": cookieHeader(request, adminToken(password), ADMIN_COOKIE_MAX_AGE) } });
}

export async function DELETE(request: Request) {
  return Response.json({ ok: true }, { headers: { "set-cookie": cookieHeader(request, "", 0) } });
}
