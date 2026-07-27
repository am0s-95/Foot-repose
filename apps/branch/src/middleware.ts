import { NextResponse, type NextRequest } from 'next/server';

/**
 * UX-only routing guard based on cookie presence. Real authentication and
 * authorization live in the API — every request is re-verified there.
 */
export function middleware(req: NextRequest): NextResponse {
  const hasSession = req.cookies.has('fr_wf_session');
  const isLogin = req.nextUrl.pathname === '/login';
  if (!hasSession && !isLogin) return NextResponse.redirect(new URL('/login', req.url));
  if (hasSession && isLogin) return NextResponse.redirect(new URL('/', req.url));
  return NextResponse.next();
}

export const config = { matcher: ['/', '/login'] };
