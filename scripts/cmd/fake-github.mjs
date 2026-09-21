// A fake GitHub REST API on 127.0.0.1, used only by `prr selftest` to exercise the real posting path (head check, review
// POST, the 422 retry) without a network. Started as a child process:  node fake-github.mjs <dir>
//   <dir>/scenario.json   read on EVERY request, so the test can change the story between calls:
//                         { "pr": <raw pulls/N response>, "login": "bob", "reject_inline": true|false,
//                           "graphql": "fail"|"errors" (default: a well-formed thread list), "threads": [<reviewThreads nodes>] }
//   <dir>/port            written once the server is listening
//   <dir>/requests.jsonl  one line per request: { method, url, auth, body }
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const dir = process.argv[2]
const scenario = () => JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'))
let lastReview = null

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
    fs.appendFileSync(path.join(dir, 'requests.jsonl'), JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization || null, body }) + '\n')
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
    const s = scenario()
    const url = req.url.split('?')[0]
    if (req.method === 'GET' && url === '/user') return send(200, { login: s.login || 'bob' })
    if (req.method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(url)) return send(200, s.pr)
    if (req.method === 'POST' && /\/pulls\/\d+\/reviews$/.test(url)) {
      if (s.reject_inline && body && Array.isArray(body.comments) && body.comments.length) {
        return send(422, { message: 'Unprocessable Entity', errors: ['Pull request review thread line must be part of the diff'] })
      }
      lastReview = body
      return send(200, { id: 555, html_url: 'http://127.0.0.1/review/555' })
    }
    if (req.method === 'GET' && /\/reviews\/555\/comments$/.test(url)) return send(200, ((lastReview && lastReview.comments) || []).map((c, i) => ({ id: 9000 + i, body: c.body })))
    if (req.method === 'POST' && /\/pulls\/\d+\/comments\/\d+\/replies$/.test(url)) return send(201, { id: 7777, body: body && body.body, in_reply_to_id: Number(url.split('/').slice(-2)[0]) })
    if (req.method === 'POST' && url === '/graphql') {
      if (s.graphql === 'fail') return send(502, { message: 'Bad gateway' })
      if (s.graphql === 'errors') return send(200, { data: null, errors: [{ message: 'API rate limit exceeded' }] })
      return send(200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: s.threads || [] } } } } })
    }
    return send(200, [])
  })
})
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(dir, 'port'), String(server.address().port)))
