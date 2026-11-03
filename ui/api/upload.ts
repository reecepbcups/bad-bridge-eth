// Vercel function: PUT /api/upload?url=<presigned url>. Same relay as scripts/artifact-proxy.mjs, since
// Succinct's artifact bucket has no CORS policy for browsers. Same origin as the app, so no CORS headers here.

// Only Succinct's mainnet artifact bucket, so this isn't an open relay.
const ALLOWED_HOST = /^spn-artifacts-mainnet\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/

export async function PUT(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get('url')
  let targetUrl: URL
  try {
    targetUrl = new URL(target ?? '')
  } catch {
    return new Response('bad ?url=', { status: 400 })
  }
  if (targetUrl.protocol !== 'https:' || !ALLOWED_HOST.test(targetUrl.hostname)) {
    return new Response(`refusing to proxy to ${targetUrl.hostname}`, { status: 403 })
  }

  const upstream = await fetch(targetUrl, { method: 'PUT', body: await request.arrayBuffer() })
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' },
  })
}
