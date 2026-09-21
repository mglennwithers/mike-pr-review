// File classification and risk signals. Cheap regex heuristics: they only decide how big a review to run and which
// lenses to wake up — never whether something is a bug — so false positives here just cost a little extra review.

const KIND_RULES = [
  ['lock', /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|packages\.lock\.json)$/],
  ['vendored', /(^|\/)(vendor|third_party|third-party|node_modules|external|Pods)\//],
  ['generated', /(\.min\.(js|css)|\.pb\.go|_pb2(_grpc)?\.py|\.g\.dart|\.generated\.\w+|\.designer\.cs|\.snap|\.map)$|(^|\/)(dist|build|out|gen|generated|__generated__|__snapshots__)\//],
  ['binary', /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|eot|mp[34]|mov|wasm|exe|dll|so|dylib|bin|parquet|sqlite|db)$/i],
  ['migration', /(^|\/)(migrations?|migrate|alembic|flyway|liquibase|db\/schema|prisma\/migrations)\/|\.sql$|schema\.prisma$|(^|\/)schema\.rb$/i],
  ['ci', /(^|\/)(\.github\/(workflows|actions)\/|\.gitlab-ci\.yml|\.circleci\/|azure-pipelines|Jenkinsfile|\.buildkite\/|bitbucket-pipelines)/],
  ['infra', /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|Containerfile|Procfile|Makefile)$|\.(tf|tfvars|hcl|bicep)$|(^|\/)(k8s|kubernetes|helm|charts|terraform|ansible|deploy|infra)\//i],
  ['deps', /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|setup\.(py|cfg)|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|[^/]+\.csproj|Directory\.Packages\.props|deno\.jsonc?)$/],
  ['test', /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright|testdata|fixtures)\/|(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$|Tests?\.(cs|java|kt|swift)$/i],
  ['docs', /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|NOTICE|CHANGELOG|AUTHORS)[^/]*$/i],
  ['config', /\.(ya?ml|toml|ini|cfg|conf|properties|env|editorconfig|json|jsonc|xml)$|(^|\/)\.[a-z]+rc(\.[a-z]+)?$|(^|\/)\.env(\.[\w.]+)?$/i],
  ['code', /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|scala|cs|fs|vb|rb|php|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|lua|pl|r|jl|dart|ex|exs|erl|hs|clj|cljs|sh|bash|zsh|ps1|psm1|sql|vue|svelte|astro|html?|css|scss|less|sol|zig|nim|groovy|proto|graphql|gql)$/i],
]

export function classifyPath(p) {
  for (const [kind, re] of KIND_RULES) if (re.test(p)) return kind
  return 'other'
}

// How much each kind counts toward "effective" review size. Lockfiles and generated output are noise for a reviewer.
export const KIND_WEIGHT = { code: 1, migration: 1.5, ci: 1.5, infra: 1.25, deps: 1, config: 0.6, test: 0.5, docs: 0.25,
  other: 0.5, lock: 0, vendored: 0, generated: 0, binary: 0 }

const TYPED_EXT = /\.(ts|tsx|mts|cts|py|pyi|go|rs|java|kt|kts|scala|cs|fs|swift|dart|hs|zig)$/i

// signal -> { path?: RegExp, content?: RegExp (tested against ADDED lines), points, critical?, lenses:[...] }
export const SIGNALS = {
  auth: { path: /(auth|login|logout|session|passw|credential|oauth|saml|sso|jwt|token|permission|rbac|acl|polic(y|ies)|guard|identity|2fa|mfa)/i,
    content: /\b(authenticat|authoriz|is_?admin|has_?(role|permission)|verify_?(token|signature|password)|bcrypt|argon2|scrypt|jwt\.|set_?cookie|csrf|cors)\w*/i,
    points: 3, critical: true, lenses: ['security', 'correctness'] },
  crypto: { path: /(crypt|cipher|secret|keystore|vault|signing|kms)/i,
    content: /\b(createCipher|createHash|hmac|AES|RSA|ECDSA|md5|sha1|random\.random|Math\.random|private_?key|secret_?key|api_?key)\b/,
    points: 3, critical: true, lenses: ['security'] },
  money: { path: /(payment|billing|invoice|checkout|charge|refund|payout|ledger|wallet|pricing|subscription|stripe|paypal)/i,
    points: 3, critical: true, lenses: ['correctness', 'security', 'data-migrations'] },
  injection: { content: /\b(eval|exec|execSync|spawn|system|popen|subprocess|shell\s*=\s*True|os\.system|Runtime\.getRuntime|dangerouslySetInnerHTML|innerHTML|v-html|raw\(|pickle\.loads?|yaml\.load\(|unserialize|ObjectInputStream|deserializ\w*|render_template_string)\b|\b(SELECT|INSERT|UPDATE|DELETE)\b[^\n]*(\$\{|%s|['"]\s*\+|\bf['"])/i,
    points: 2, lenses: ['security'] },
  sql: { content: /\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|\.raw\(|\.execute\(|cursor\.|createQueryBuilder|knex|sequelize|prisma\.|\.query\()/i,
    points: 1, lenses: ['security', 'performance', 'data-migrations'] },
  migration: { kinds: ['migration'], points: 3, critical: true, lenses: ['data-migrations'] },
  schema: { content: /\b(ALTER\s+TABLE|DROP\s+(TABLE|COLUMN|INDEX)|CREATE\s+(UNIQUE\s+)?INDEX|ADD\s+COLUMN|NOT\s+NULL|add_column|remove_column|AddField|RemoveField|AlterField)\b/i,
    points: 2, lenses: ['data-migrations'] },
  // Bare async/await is too common to be a signal; look for real coordination primitives.
  concurrency: { content: /\b(asyncio\.(gather|create_task|Lock|Queue|wait)|Promise\.(all|allSettled|race|any)|parallel\(|flock|lockfile|O_EXCL|setTimeout|setInterval|Thread|threading|Mutex|RwLock|Lock\(|synchronized|volatile|atomic|goroutine|go\s+func|chan\s|select\s*\{|WaitGroup|tokio::|spawn\(|Semaphore|ConcurrentHashMap|ExecutorService|CompletableFuture|Task\.Run|Parallel\.|worker_threads|multiprocessing)\b/,
    points: 1, lenses: ['concurrency'] },
  // Explicit transaction control: the code is coordinating concurrent writers, whatever the language.
  transactions: { content: /\b(BEGIN\s+(IMMEDIATE|EXCLUSIVE|TRANSACTION)|START\s+TRANSACTION|SAVEPOINT|ROLLBACK|FOR\s+UPDATE|SERIALIZABLE|isolation_level|\.transaction\(|transaction\.atomic|@Transactional|BeginTx|begin_nested)/i,
    points: 1, lenses: ['concurrency'] },
  public_api: { path: /(^|\/)(api|routes?|controllers?|handlers?|endpoints?|graphql|proto|openapi|swagger|public|sdk)\/|openapi\.(ya?ml|json)$|\.proto$|\.graphql$|(^|\/)index\.(ts|js|d\.ts)$|\.d\.ts$/i,
    content: /(@(Get|Post|Put|Patch|Delete|Request)Mapping|@(app|router|blueprint)\.(route|get|post|put|patch|delete)|@api_view|\b(app|router|server)\.(get|post|put|patch|delete|all)\(\s*['"`/]|\bhttp\.HandleFunc\(|\bMap(Get|Post|Put|Delete)\(|__all__\s*=|^\s*(message|service|rpc)\s+\w+)/m,
    points: 1, lenses: ['api-compat'] },
  error_handling: { content: /\b(try\s*[:{]|catch\s*[({]|except\b|rescue\b|finally\b|\.catch\(|on_?error|unwrap\(\)|expect\(|panic!?\(|recover\(\)|if\s+err\s*!=\s*nil|Result<|raise\s|throw\s|\?\?|\|\|\s*(null|\[\]|\{\}|''|""|0|None|default))/i,
    points: 0, lenses: ['errors'] },
  perf: { content: /\b(for\s*\(.*\)\s*\{[^}]*\b(await|query|find|fetch)|\.forEach\(async|N\+1|SELECT\s+\*|\.findAll\(|\.all\(\)|readFileSync|sleep\(|time\.sleep|new\s+RegExp|re\.compile|JSON\.parse\(JSON\.stringify|deepcopy|cache|memo|lru_cache|useMemo|useEffect|O\(n)/i,
    points: 0, lenses: ['performance'] },
  types: { content: /^\s*(export\s+)?(abstract\s+)?(interface|type\s+\w+\s*=|enum|class|struct|trait|protocol|record|sealed|data\s+class|@dataclass|class\s+\w+\((BaseModel|TypedDict|NamedTuple|Enum|Protocol))/m,
    ext: TYPED_EXT, points: 0, lenses: ['types'] },
  ci: { kinds: ['ci'], content: /(pull_request_target|secrets\.|permissions:|id-token|curl\s.+\|\s*(ba)?sh|--no-verify|continue-on-error)/,
    points: 2, critical: true, lenses: ['infra-config', 'security'] },
  infra: { kinds: ['infra'], points: 2, lenses: ['infra-config'] },
  deps: { kinds: ['deps', 'lock'], points: 1, lenses: ['dependencies'] },
  config: { kinds: ['config'], points: 0, lenses: ['infra-config'] },
  feature_flag: { content: /\b(feature_?flag|isEnabled\(|LaunchDarkly|unleash|flipper|toggle)\b/i, points: 1, lenses: ['correctness'] },
  tests_removed: { points: 2, lenses: ['tests'] }, // computed, see below
  secrets: { content: /(AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|(password|passwd|secret|api_?key|token)\s*[:=]\s*['"][^'"\s]{8,}['"])/i,
    points: 3, critical: true, lenses: ['security'] },
}

export function detectSignals(files) {
  const found = {}
  const hit = (name, file) => { (found[name] ||= { files: [] }).files.push(file.path) }
  for (const f of files) {
    if (KIND_WEIGHT[f.kind] === 0 && f.kind !== 'lock') continue
    const added = f.hunks.flatMap((h) => h.lines.filter((l) => l.t === '+').map((l) => l.s)).join('\n')
    for (const [name, s] of Object.entries(SIGNALS)) {
      if (name === 'tests_removed') continue
      if (s.ext && !s.ext.test(f.path)) continue
      const byKind = s.kinds && s.kinds.includes(f.kind)
      const byPath = s.path && f.kind !== 'docs' && s.path.test(f.path)
      const byContent = s.content && f.kind !== 'docs' && f.kind !== 'lock' && added && s.content.test(added)
      if (byKind || byPath || byContent) hit(name, f)
    }
    if (f.kind === 'test' && (f.status === 'deleted' || f.deleted > f.added + 20)) hit('tests_removed', f)
  }
  const signals = Object.entries(found).map(([name, v]) => ({
    name, points: SIGNALS[name].points, critical: !!SIGNALS[name].critical, lenses: SIGNALS[name].lenses,
    files: Array.from(new Set(v.files)),
  }))
  signals.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
  return signals
}
