// Vercel function: GET /api/download?url=<artifact url>. Download side of api/upload.ts, same CORS gap.

// Only Succinct's mainnet artifact bucket, so this isn't an open relay.
const ALLOWED_HOST = /^spn-artifacts-mainnet\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/

export async function GET(request: Request): Promise<Response> {
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

  const upstream = await fetch(targetUrl)
  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers: { 'content-type': 'application/octet-stream' },
  })
}
