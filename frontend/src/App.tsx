import { useCallback, useEffect, useMemo, useState } from 'react'
import './index.css'

type QueryType = 'keyword' | 'url' | 'image'
type SortMode = 'score' | 'platform' | 'newest'
type StageKey = 'validate' | 'resolve' | 'brain' | 'collect' | 'dedup' | 'score' | 'persist' | 'done'

interface SearchResult {
  searchId: string
  status: 'pending' | 'running' | 'done' | 'completed' | 'failed' | 'complete' | 'partial'
  results: VideoResult[]
  productInfo: ProductInfo | null
  targetResults?: number
  sourceKinds?: Record<string, 'organic' | 'ads' | 'unknown'>
  dropReasons?: Record<string, number>
}

interface ProductInfo {
  title: string
  imageUrl: string
  description?: string
  attributes?: ProductAttributes
}

interface ProductAttributes {
  productType?: string
  colors?: string[]
  patterns?: string[]
  logoOrText?: string
  material?: string
  shape?: string
  searchQueries?: string[]
  adKeywords?: string[]
  matchCriteria?: string
}

interface VideoResult {
  id: string
  videoId?: string
  platform: string
  platformId?: string
  url: string
  thumbnailUrl: string
  caption: string
  score: number
  label: 'match' | 'possible' | 'discard'
  reason: string
  metaPath?: string
  contentType?: string
  sourceKind?: 'organic' | 'ads' | 'unknown'
  isPaidPartnership?: boolean
  paidMarkerDetected?: string
  dropReason?: string
  shortlisted?: boolean
}

interface HistoryItem {
  id: string
  query: string
  queryType: QueryType
  productTitle: string
  status: string
  createdAt: string
}

interface SearchPayload {
  query: string
  queryType: QueryType
  imageFile?: string
  showSeen: boolean
}

interface ProcessSnapshot {
  got?: number
  wanted?: number
  source?: string
  scored?: number
  total?: number
  shortfall?: number
  targetResults?: number
  dropReasons?: Record<string, number>
}

const STAGES: Array<{ key: StageKey; label: string; description: string; seconds: number }> = [
  { key: 'validate', label: 'Validate', description: 'Input accepted', seconds: 4 },
  { key: 'resolve', label: 'Resolve', description: 'Product identity', seconds: 10 },
  { key: 'brain', label: 'Analyze', description: 'Visual signals', seconds: 22 },
  { key: 'collect', label: 'Collect', description: 'Instagram reels', seconds: 60 },
  { key: 'dedup', label: 'Dedup', description: 'Remove repeats', seconds: 10 },
  { key: 'score', label: 'Score', description: 'Rank relevance', seconds: 28 },
  { key: 'persist', label: 'Save', description: 'Write results', seconds: 8 },
  { key: 'done', label: 'Done', description: 'Ready to review', seconds: 1 },
]

const TOTAL_EXPECTED_SECONDS = STAGES.reduce((total, stage) => total + stage.seconds, 0)

function useHealth() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')
  useEffect(() => {
    fetch('/api/health')
      .then(r => r.json())
      .then(d => setStatus(d.status === 'ok' ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
  }, [])
  return status
}

function useNow(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [enabled])

  return now
}

function formatDuration(seconds: number) {
  if (seconds <= 0) return 'less than 1 min'
  if (seconds < 60) return `${Math.ceil(seconds)} sec`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} min`
}

function stageIndex(stage: string) {
  const index = STAGES.findIndex(item => item.key === stage)
  return index < 0 ? 0 : index
}

function stageCompletion(stage: StageKey, snapshot: ProcessSnapshot) {
  if (stage === 'collect' && snapshot.wanted) {
    return Math.min(0.95, Math.max(0.15, (snapshot.got ?? 0) / snapshot.wanted))
  }
  if (stage === 'score' && snapshot.total) {
    return Math.min(0.95, Math.max(0.2, (snapshot.scored ?? 0) / snapshot.total))
  }
  if (stage === 'done') return 1
  return 0.55
}

function getProgressPercent(activeStage: StageKey, snapshot: ProcessSnapshot) {
  const currentIndex = stageIndex(activeStage)
  const completedSeconds = STAGES.slice(0, currentIndex).reduce((sum, item) => sum + item.seconds, 0)
  const currentSeconds = STAGES[currentIndex]?.seconds ?? 0
  const completion = stageCompletion(activeStage, snapshot)
  return Math.min(100, Math.round(((completedSeconds + currentSeconds * completion) / TOTAL_EXPECTED_SECONDS) * 100))
}

function Header({ health }: { health: 'checking' | 'ok' | 'down' }) {
  return (
    <header className="topbar">
      <div className="topbar__inner">
        <a className="brand" href="#search-input" aria-label="WishLuck Discovery home">
          <span className="brand__mark">WL</span>
          <span>
            <strong>WishLuck Discovery</strong>
            <small>Product video intelligence</small>
          </span>
        </a>
        <div className={`health health--${health}`}>
          <span />
          {health === 'checking' ? 'Checking API' : health === 'ok' ? 'API online' : 'API offline'}
        </div>
      </div>
    </header>
  )
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function SearchBar({
  onSearch,
  loading,
  showSeen,
  onShowSeenChange,
}: {
  onSearch: (payload: SearchPayload) => void
  loading: boolean
  showSeen: boolean
  onShowSeenChange: (value: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [queryType, setQueryType] = useState<QueryType>('keyword')
  const [imageFile, setImageFile] = useState<string | undefined>()

  const extractUrl = (val: string) => {
    const markdownMatch = val.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i)
    const rawMatch = val.match(/https?:\/\/[^\s)]+/i)
    return (markdownMatch?.[1] ?? rawMatch?.[0] ?? val).replace(/\\&/g, '&').trim()
  }

  const detectType = (val: string) => {
    if (imageFile) return
    try {
      new URL(extractUrl(val))
      setQueryType('url')
    } catch {
      setQueryType('keyword')
    }
  }

  const handleFile = async (file?: File) => {
    if (!file) {
      setImageFile(undefined)
      detectType(query)
      return
    }
    setImageFile(await fileToDataUrl(file))
    setQueryType('image')
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const cleanedQuery = extractUrl(query)
    if (queryType !== 'image' && !cleanedQuery) return
    if (queryType === 'image' && !imageFile) return
    onSearch({ query: cleanedQuery, queryType, imageFile, showSeen })
  }

  return (
    <section className="search-surface panel-enter">
      <div className="search-copy">
        <p className="eyebrow">Discovery workspace</p>
        <h1>Find product videos worth reviewing.</h1>
        <p>Search by keyword, product page, or image while the pipeline reports exactly where it is.</p>
      </div>

      <form onSubmit={handleSubmit} className="search-form">
        <div className="search-field">
          <input
            id="search-input"
            value={query}
            onChange={e => { setQuery(e.target.value); detectType(e.target.value) }}
            placeholder="Paste a product URL or type a product keyword"
          />
          <span className="query-pill">{queryType}</span>
        </div>

        <label className={`image-upload ${imageFile ? 'image-upload--ready' : ''}`}>
          <span>{imageFile ? 'Image ready' : 'Image'}</span>
          <input type="file" accept="image/*" onChange={e => handleFile(e.target.files?.[0])} />
        </label>

        <button
          id="search-submit"
          className="primary-action"
          disabled={loading || (queryType === 'image' ? !imageFile : !query.trim())}
        >
          <span>{loading ? 'Searching' : 'Search'}</span>
        </button>
      </form>

      <div className="search-options">
        <label className="switch">
          <input type="checkbox" checked={showSeen} onChange={e => onShowSeenChange(e.target.checked)} />
          <span aria-hidden="true" />
          Show previously seen videos
        </label>
        <span className="microcopy">Source: Instagram reels with no detected paid markers</span>
      </div>
    </section>
  )
}

function ProcessIndicator({
  stage,
  detail,
  snapshot,
  startedAt,
  loading,
}: {
  stage: StageKey
  detail: string
  snapshot: ProcessSnapshot
  startedAt: number | null
  loading: boolean
}) {
  const now = useNow(loading)
  const currentIndex = stageIndex(stage)
  const progress = getProgressPercent(stage, snapshot)
  const elapsed = startedAt ? Math.round((now - startedAt) / 1000) : 0
  const estimatedTotal = Math.max(TOTAL_EXPECTED_SECONDS, elapsed / Math.max(progress / 100, 0.08))
  const timeLeft = stage === 'done' ? 0 : Math.max(0, estimatedTotal - elapsed)
  const currentStage = STAGES[currentIndex]

  return (
    <section className="process-panel panel-enter" aria-live="polite">
      <div className="process-panel__top">
        <div>
          <p className="eyebrow">Live process</p>
          <h2>{currentStage.label}: {currentStage.description}</h2>
          <p>{detail}</p>
        </div>
        <div className="eta-card">
          <span>{formatDuration(timeLeft)}</span>
          <small>estimated left</small>
        </div>
      </div>

      <div className="progress-rail" aria-label={`Search progress ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="stage-grid">
        {STAGES.map((item, index) => {
          const state = index < currentIndex || stage === 'done' ? 'complete' : index === currentIndex ? 'active' : 'waiting'
          return (
            <div key={item.key} className={`stage-card stage-card--${state}`}>
              <span className="stage-dot" />
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </div>
          )
        })}
      </div>

      {(snapshot.wanted || snapshot.total) && (
        <div className="process-metrics">
          {snapshot.source && <span>{snapshot.source} active</span>}
          {snapshot.wanted && <span>{snapshot.got ?? 0}/{snapshot.wanted} candidates</span>}
          {typeof snapshot.shortfall === 'number' && snapshot.shortfall > 0 && <span>{snapshot.shortfall} shortfall</span>}
          {snapshot.total && <span>{snapshot.scored ?? 0}/{snapshot.total} scored</span>}
        </div>
      )}
    </section>
  )
}

function ProductPanel({ product }: { product: ProductInfo }) {
  const attributes = product.attributes
  const chips = [
    attributes?.productType,
    ...(attributes?.colors ?? []),
    ...(attributes?.patterns ?? []),
    attributes?.logoOrText && attributes.logoOrText !== 'none' ? attributes.logoOrText : undefined,
    attributes?.material,
    attributes?.shape,
  ].filter((item): item is string => Boolean(item && item !== 'unknown' && item !== 'none')).slice(0, 10)

  return (
    <section className="product-panel panel-enter">
      <div className="product-frame">
        {product.imageUrl ? <img src={product.imageUrl} alt="Resolved product" /> : <span>No image</span>}
      </div>
      <div className="product-copy">
        <p className="eyebrow">Resolved product</p>
        <h2>{product.title || 'Product'}</h2>
        {product.description && <p>{product.description.slice(0, 220)}</p>}
        {chips.length > 0 && (
          <div className="attribute-chips">
            {chips.map((chip, index) => <span key={`${chip}-${index}`}>{chip}</span>)}
          </div>
        )}
        {attributes?.matchCriteria && <p className="match-criteria">{attributes.matchCriteria}</p>}
      </div>
    </section>
  )
}

function HistorySidebar({ history, onSelect }: { history: HistoryItem[]; onSelect: (id: string) => void }) {
  return (
    <aside className="history-panel">
      <div className="sidebar-heading">
        <p className="eyebrow">Workspace</p>
        <h2>Search history</h2>
      </div>
      {history.length === 0 ? (
        <p className="empty-note">No previous searches yet.</p>
      ) : (
        <div className="history-list">
          {history.map(item => (
            <button key={item.id} onClick={() => onSelect(item.id)} className="history-item">
              <strong>{item.productTitle || item.query || 'Untitled search'}</strong>
              <span>{item.queryType} / {item.status}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

function FilterBar({
  activeSource,
  onSourceChange,
  minScore,
  onMinScoreChange,
  sortMode,
  onSortModeChange,
  counts,
  sources,
}: {
  activeSource: string
  onSourceChange: (source: string) => void
  minScore: number
  onMinScoreChange: (value: number) => void
  sortMode: SortMode
  onSortModeChange: (value: SortMode) => void
  counts: Record<string, number>
  sources: string[]
}) {
  return (
    <section className="filter-bar panel-enter">
      <div className="segmented-control" aria-label="Filter by source">
        {sources.map(source => (
          <button key={source} onClick={() => onSourceChange(source)} className={activeSource === source ? 'is-active' : ''}>
            {source} <span>{counts[source] ?? 0}</span>
          </button>
        ))}
      </div>

      <label className="score-filter">
        <span>Min score</span>
        <strong>{minScore}</strong>
        <input type="range" min={0} max={100} value={minScore} onChange={e => onMinScoreChange(Number(e.target.value))} />
      </label>

      <select value={sortMode} onChange={e => onSortModeChange(e.target.value as SortMode)} aria-label="Sort results">
        <option value="score">Sort by score</option>
        <option value="platform">Sort by platform</option>
        <option value="newest">Sort by newest</option>
      </select>
    </section>
  )
}

function VideoCard({
  video,
  shortlisted,
  onToggleShortlist,
}: {
  video: VideoResult
  shortlisted: boolean
  onToggleShortlist: (videoId: string) => void
}) {
  const scorePercent = Math.round(video.score * 100)
  const labelClass = video.label === 'match' ? 'badge-match' : video.label === 'possible' ? 'badge-possible' : 'badge-discard'
  const sourceKind = video.sourceKind ?? (video.platform === 'meta' ? 'ads' : 'unknown')
  return (
    <article className="video-card panel-enter">
      <div className="thumbnail">
        {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="Video thumbnail" /> : <div className="thumbnail__missing">No thumbnail</div>}
        <span>{video.platform}{sourceKind === 'ads' ? ' / ad' : video.contentType ? ` / ${video.contentType}` : ''}</span>
      </div>
      <div className="video-card__body">
        <div className="result-row">
          <span className={labelClass}>{video.label}</span>
          <strong>{scorePercent}</strong>
        </div>
        <div className="reason-box">
          <span>Reason</span>
          <p>{video.reason || 'No reason provided.'}</p>
        </div>
        {video.caption && (
          <p className="caption">{video.caption.slice(0, 150)}{video.caption.length > 150 ? '...' : ''}</p>
        )}
        <div className="card-actions">
          <button type="button" className={shortlisted ? 'shortlist-action is-active' : 'shortlist-action'} onClick={() => onToggleShortlist(video.videoId ?? video.id)}>
            {shortlisted ? 'Shortlisted' : 'Shortlist'}
          </button>
          <a href={video.url || undefined} target="_blank" rel="noreferrer" className="open-link">
            Open video
          </a>
        </div>
      </div>
    </article>
  )
}

function EmptyState({ message, hint }: { message: string; hint: string }) {
  return (
    <section className="empty-state panel-enter">
      <div className="empty-state__orb" />
      <h2>{message}</h2>
      <p>{hint}</p>
    </section>
  )
}

export default function App() {
  const health = useHealth()
  const [loading, setLoading] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<{ code?: string; message: string; hint?: string } | null>(null)
  const [activeStage, setActiveStage] = useState<StageKey>('validate')
  const [progressDetail, setProgressDetail] = useState('Validating search input')
  const [processSnapshot, setProcessSnapshot] = useState<ProcessSnapshot>({})
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [activeSource, setActiveSource] = useState('all')
  const [minScore, setMinScore] = useState(0)
  const [sortMode, setSortMode] = useState<SortMode>('score')
  const [showSeen, setShowSeen] = useState(false)
  const [shortlistedIds, setShortlistedIds] = useState<Set<string>>(new Set())

  const refreshHistory = useCallback(async () => {
    try {
      const data = await fetch('/api/history?limit=20').then(r => r.json())
      setHistory(data.searches ?? [])
    } catch {
      setHistory([])
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    refreshHistory()
  }, [refreshHistory])

  async function loadSearch(searchId: string) {
    const data = await fetch(`/api/search/${searchId}`).then(r => r.json())
    setSearchResult({
      searchId,
      status: data.status,
      results: data.results ?? [],
      productInfo: data.productInfo ?? null,
      targetResults: data.targetResults,
      sourceKinds: data.sourceKinds,
      dropReasons: data.dropReasons,
    })
    setShortlistedIds(new Set((data.results ?? []).filter((result: VideoResult) => result.shortlisted).map((result: VideoResult) => result.videoId ?? result.id)))
    setActiveStage('done')
    setProgressDetail('Search complete')
    setProcessSnapshot({})
    setProgressStartedAt(null)
    setActiveSource('all')
    setError(null)
  }

  async function handleSearch(payload: SearchPayload) {
    setLoading(true)
    setError(null)
    setSearchResult(null)
    setActiveStage('validate')
    setProgressDetail('Validating search input')
    setProcessSnapshot({})
    setProgressStartedAt(Date.now())

    try {
      const resp = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await resp.json()
      if (!resp.ok) {
        setError(data.error ?? { message: 'Request failed', hint: 'Try a broader query.' })
        setLoading(false)
        return
      }

      const { searchId } = data
      const sse = new EventSource(`/api/search/${searchId}/events`)
      sse.onmessage = (e) => {
        const evt = JSON.parse(e.data)
        if (evt.stage) {
          setActiveStage(evt.stage)
          if (evt.stage === 'validate') {
            setProgressDetail('Validated input and queued the search')
            setProcessSnapshot({})
          }
          if (evt.stage === 'resolve') {
            setProgressDetail(`Resolved product: ${evt.product?.title ?? 'product'}`)
            setProcessSnapshot({})
          }
          if (evt.stage === 'brain') {
            setProgressDetail('Extracted visual attributes and search terms')
            setProcessSnapshot({})
          }
          if (evt.stage === 'collect') {
            const source = evt.source ? `${evt.source}: ` : ''
            const shortfall = typeof evt.shortfall === 'number' && evt.shortfall > 0 ? `, shortfall ${evt.shortfall}` : ''
            setProgressDetail(`${source}${evt.got}/${evt.wanted} candidates collected${shortfall}`)
            setProcessSnapshot({ source: evt.source, got: evt.got, wanted: evt.wanted, shortfall: evt.shortfall, targetResults: evt.targetResults, dropReasons: evt.dropReasons })
          }
          if (evt.stage === 'dedup') {
            setProgressDetail(`Deduplicated ${evt.before} candidates to ${evt.after}`)
            setProcessSnapshot({})
          }
          if (evt.stage === 'score') {
            setProgressDetail(`Scored ${evt.scored ?? 0}/${evt.total ?? 0} candidates`)
            setProcessSnapshot({ scored: evt.scored, total: evt.total })
          }
          if (evt.stage === 'persist') {
            setProgressDetail('Saving results to SQLite')
            setProcessSnapshot({})
          }
          if (evt.stage === 'done') {
            setProgressDetail('Search complete')
            setProcessSnapshot({})
          }
          if (evt.stage === 'error') setProgressDetail('Search failed')
        }
        if (evt.stage === 'done') {
          sse.close()
          setLoading(false)
          setSearchResult({
            searchId,
            status: evt.status ?? 'done',
            results: evt.results ?? [],
            productInfo: evt.productInfo ?? null,
            targetResults: evt.targetResults,
            sourceKinds: evt.sourceKinds,
            dropReasons: evt.dropReasons,
          })
          setShortlistedIds(new Set())
          setActiveSource('all')
          refreshHistory()
        }
        if (evt.stage === 'error') {
          sse.close()
          setLoading(false)
          setError(evt.error ?? { message: 'Search failed', hint: 'Check backend logs.' })
          refreshHistory()
        }
      }
      sse.onerror = () => {
        sse.close()
        setTimeout(() => {
          loadSearch(searchId).finally(() => {
            setLoading(false)
            refreshHistory()
          })
        }, 1200)
      }
    } catch {
      setError({ message: 'Cannot reach server', hint: 'Make sure backend and Redis are running.' })
      setLoading(false)
    }
  }

  const results = useMemo(() => searchResult?.results ?? [], [searchResult?.results])
  const counts = useMemo(() => ({
    all: results.length,
    ...Object.fromEntries(Array.from(new Set(results.map(result => result.platform))).map(source => [
      source,
      results.filter(result => result.platform === source).length,
    ])),
  }), [results])
  const sourceTabs = useMemo(() => ['all', ...Array.from(new Set(results.map(result => result.platform)))], [results])

  const visibleResults = useMemo(() => {
    const filtered = results.filter(result => {
      const sourceOk = activeSource === 'all' || result.platform === activeSource
      const scoreOk = minScore === 0 || Math.round(result.score * 100) >= minScore
      return sourceOk && scoreOk
    })

    return [...filtered].sort((a, b) => {
      if (sortMode === 'platform') return a.platform.localeCompare(b.platform)
      if (sortMode === 'newest') return String(b.id).localeCompare(String(a.id))
      return b.score - a.score
    })
  }, [results, activeSource, minScore, sortMode])

  const matchCount = results.filter(result => result.label !== 'discard').length
  const targetResults = searchResult?.targetResults ?? Math.max(20, results.length)
  const counterTone = results.length >= targetResults ? 'good' : results.length >= Math.ceil(targetResults / 2) ? 'warn' : 'danger'
  const shortlistCount = shortlistedIds.size

  async function persistShortlist(nextIds: Set<string>) {
    if (!searchResult) return
    await fetch('/api/shortlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchId: searchResult.searchId, videoIds: Array.from(nextIds) }),
    }).catch(() => undefined)
  }

  function toggleShortlist(videoId: string) {
    const next = new Set(shortlistedIds)
    if (next.has(videoId)) next.delete(videoId)
    else next.add(videoId)
    setShortlistedIds(next)
    void persistShortlist(next)
  }

  return (
    <div className="app-shell">
      <div className="scene-grid" aria-hidden="true" />
      <Header health={health} />
      <main className="app-layout">
        <HistorySidebar history={history} onSelect={loadSearch} />
        <div className="content-stack">
          <SearchBar onSearch={handleSearch} loading={loading} showSeen={showSeen} onShowSeenChange={setShowSeen} />
          {loading && (
            <ProcessIndicator
              stage={activeStage}
              detail={progressDetail}
              snapshot={processSnapshot}
              startedAt={progressStartedAt}
              loading={loading}
            />
          )}
          {error && (
            <section className="error-panel panel-enter">
              <strong>{error.message}</strong>
              {error.hint && <p>Next step: {error.hint}</p>}
            </section>
          )}
          {searchResult?.productInfo && <ProductPanel product={searchResult.productInfo} />}
          {searchResult && (
            <>
              <section className="results-heading panel-enter">
                <div>
                  <p className="eyebrow">Results</p>
                  <h2>Candidate videos</h2>
                </div>
                <div className="results-actions">
                  <strong className={`counter counter--${counterTone}`}>
                    {results.length}/{targetResults} collected, {matchCount} usable
                  </strong>
                  <span className="shortlist-count">{shortlistCount} shortlisted</span>
                  <a className={shortlistCount ? 'export-link' : 'export-link is-disabled'} href={shortlistCount ? `/api/shortlist/export?searchId=${searchResult.searchId}&format=csv` : undefined}>
                    Export CSV
                  </a>
                  <a className={shortlistCount ? 'export-link' : 'export-link is-disabled'} href={shortlistCount ? `/api/shortlist/export?searchId=${searchResult.searchId}&format=json` : undefined}>
                    JSON
                  </a>
                </div>
              </section>
              <FilterBar
                activeSource={activeSource}
                onSourceChange={setActiveSource}
                minScore={minScore}
                onMinScoreChange={setMinScore}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                counts={counts}
                sources={sourceTabs}
              />
              {visibleResults.length === 0 ? (
                <EmptyState message="No visible results" hint="Try lowering the score filter, switching tabs, or searching a broader product." />
              ) : (
                <section className="video-grid">
                  {visibleResults.map(video => (
                    <VideoCard
                      key={`${video.platform}-${video.id}`}
                      video={video}
                      shortlisted={shortlistedIds.has(video.videoId ?? video.id)}
                      onToggleShortlist={toggleShortlist}
                    />
                  ))}
                </section>
              )}
            </>
          )}
          {!searchResult && !loading && !error && (
            <EmptyState message="Start a product search" hint="Use a keyword, paste a product page URL, or upload the product image." />
          )}
        </div>
      </main>
    </div>
  )
}
