import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { CategoryScale, Chart as ChartJS, Filler, LinearScale, LineElement, PointElement, Tooltip } from 'chart.js'
import { Line } from 'react-chartjs-2'
import Papa from 'papaparse'
import { supabase } from './supabase'
import './App.css'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler)

const expectedCsvColumns = ['date', 'product', 'quantity', 'price', 'discount']
const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+.[a-zA-Z]{2,}$/

const demoProducts = [
  { name: 'Rice 25kg', baseQuantity: 18, monthlyTrend: 1.02, price: 2350, discount: 3 },
  { name: 'Dal 1kg', baseQuantity: 34, monthlyTrend: 1.01, price: 185, discount: 2 },
  { name: 'Cooking Oil 1L', baseQuantity: 28, monthlyTrend: .98, price: 210, discount: 2 },
  { name: 'Sugar 1kg', baseQuantity: 30, monthlyTrend: 1.015, price: 125, discount: 1 },
  { name: 'Wai Wai noodles', baseQuantity: 72, monthlyTrend: 1.04, price: 25, discount: 0 },
  { name: 'Tea 500g', baseQuantity: 22, monthlyTrend: 1.025, price: 285, discount: 3 },
]

function normalizeProductName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildDemoSales(shopId, products) {
  const today = new Date()
  return products.flatMap((product) => Array.from({ length: 12 }, (_, monthIndex) => {
    const soldOn = new Date(today.getFullYear(), today.getMonth() - 11 + monthIndex, 1)
    const seasonalBump = soldOn.getMonth() === 9 ? 1.4 : 1
    const quantity = Math.max(1, Math.round(product.baseQuantity * product.monthlyTrend ** monthIndex * seasonalBump))
    return { shop_id: shopId, product_id: product.id, sold_on: formatLocalDate(soldOn), quantity, price: product.price, discount: product.discount }
  }))
}

function getSaleRevenue(sale) {
  const quantity = Number(sale.quantity) || 0
  const price = Number(sale.price) || 0
  const discount = Number(sale.discount) || 0
  return quantity * price * (1 - discount / 100)
}

function getMonthKey(dateValue) {
  const date = new Date(dateValue)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

function getMonthKeysEndingAt(latestMonth, count) {
  if (!latestMonth) return []
  const [year, month] = latestMonth.split('-').map(Number)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(year, month - 1 - (count - 1 - index), 1)
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  })
}

function formatMonth(monthKey) {
  const [year, month] = monthKey.split('-').map(Number)
  return new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(year, month - 1, 1))
}

function formatCurrency(amount) {
  return `रू ${Math.round(amount).toLocaleString('en-IN')}`
}

function fitLinearTrend(values) {
  if (values.length === 1) return { slope: 0, intercept: values[0] }
  const xMean = (values.length - 1) / 2
  const yMean = values.reduce((total, value) => total + value, 0) / values.length
  const numerator = values.reduce((total, value, index) => total + (index - xMean) * (value - yMean), 0)
  const denominator = values.reduce((total, _value, index) => total + (index - xMean) ** 2, 0)
  const slope = denominator ? numerator / denominator : 0
  return { slope, intercept: yMean - slope * xMean }
}

function buildForecastRows(shopId, products, sales) {
  const latestMonth = sales.map((sale) => getMonthKey(sale.sold_on)).filter(Boolean).sort().at(-1) || ''
  if (!latestMonth) return []
  const [latestYear, latestMonthNumber] = latestMonth.split('-').map(Number)
  const targetMonth = formatLocalDate(new Date(latestYear, latestMonthNumber, 1))

  return products.flatMap((product) => {
    const monthlyTotals = new Map()
    sales.filter((sale) => sale.product_id === product.id).forEach((sale) => {
      const monthKey = getMonthKey(sale.sold_on)
      if (monthKey) monthlyTotals.set(monthKey, (monthlyTotals.get(monthKey) || 0) + (Number(sale.quantity) || 0))
    })
    const monthKeys = [...monthlyTotals.keys()].sort()
    if (monthKeys.length === 0) return []
    const quantities = monthKeys.map((monthKey) => monthlyTotals.get(monthKey))
    const lastThreeMonths = quantities.slice(-3)
    const average = lastThreeMonths.reduce((total, quantity) => total + quantity, 0) / lastThreeMonths.length
    const trend = fitLinearTrend(quantities)
    const trendForecast = trend.slope * quantities.length + trend.intercept
    let predictedQuantity = trendForecast
    if (monthKeys.length >= 12) {
      const seasonalRatios = new Map()
      quantities.forEach((quantity, index) => {
        const fittedValue = trend.slope * index + trend.intercept
        if (fittedValue <= 0) return
        const calendarMonth = Number(monthKeys[index].split('-')[1])
        const ratios = seasonalRatios.get(calendarMonth) || []
        ratios.push(quantity / fittedValue)
        seasonalRatios.set(calendarMonth, ratios)
      })
      const targetCalendarMonth = Number(targetMonth.split('-')[1])
      const targetRatios = seasonalRatios.get(targetCalendarMonth)
      if (targetRatios?.length) {
        const averageRatio = targetRatios.reduce((total, ratio) => total + ratio, 0) / targetRatios.length
        const shrunkRatio = 1 + (averageRatio - 1) / 2
        predictedQuantity *= shrunkRatio
      }
    }
    predictedQuantity = Math.max(0, predictedQuantity)
    const changePct = average ? ((predictedQuantity - average) / average) * 100 : 0
    const roundedChange = Number(changePct.toFixed(2))
    const absoluteChange = Math.round(Math.abs(roundedChange))
    const advice = roundedChange >= 8 ? `Increase stock by ${absoluteChange}%` : roundedChange <= -8 ? `Reduce stock by ${absoluteChange}%` : 'Keep stock level'
    return [{ shop_id: shopId, product_id: product.id, target_month: targetMonth, predicted_qty: Number(predictedQuantity.toFixed(2)), change_pct: roundedChange, advice }]
  })
}

function Logo() { return <span className="brand-mark" aria-hidden="true">S</span> }

function Navbar() {
  const navigate = useNavigate()
  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/login')
  }
  return <header className="topbar">
    <Link to="/dashboard" className="brand" aria-label="SalesSathi dashboard"><Logo /><span>Sales<span className="brand-accent">Sathi</span></span></Link>
    <nav className="nav-links" aria-label="Main navigation">
      <NavLink to="/dashboard" className={({ isActive }) => isActive ? 'active' : ''}>Dashboard</NavLink>
      <button className="logout-button" type="button" onClick={handleLogout}>Log out</button>
    </nav>
  </header>
}

function AuthLayout({ children, eyebrow, title, copy }) {
  return <main className="auth-page">
    <div className="auth-intro">
      <Link to="/login" className="brand auth-brand"><Logo /><span>Sales<span className="brand-accent">Sathi</span></span></Link>
      <div className="intro-copy"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{copy}</p></div>
      <div className="trust-note"><span className="spark">✦</span> Made for Nepal&apos;s local shops</div>
    </div>
    <section className="auth-panel">{children}</section>
  </main>
}

function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [emailError, setEmailError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  async function handleSubmit(event) {
    event.preventDefault()
    const normalizedEmail = email.trim().toLowerCase()
    if (!emailRegex.test(normalizedEmail)) {
      setEmailError('Enter a valid email address')
      return
    }
    setEmail(normalizedEmail)
    setEmailError('')
    setError('')
    setIsSubmitting(true)
    const { error: authError } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password })
    if (authError) setError(authError.message)
    else navigate('/dashboard')
    setIsSubmitting(false)
  }
  return <AuthLayout eyebrow="Welcome back" title="Know what to stock next." copy="Simple sales insights that help your shop stay ready for tomorrow.">
    <div className="form-heading"><p className="eyebrow">Sign in</p><h2>Welcome back</h2><p>Enter your details to see your shop overview.</p></div>
    <form onSubmit={handleSubmit}>
      <label htmlFor="login-email">Email address</label>
      <input id="login-email" type="email" placeholder="you@example.com" value={email} onChange={(event) => { setEmail(event.target.value); setEmailError('') }} required />
      {emailError && <p className="field-error" role="alert">{emailError}</p>}
      <div className="label-row"><label htmlFor="login-password">Password</label><a href="#forgot">Forgot password?</a></div>
      <input id="login-password" type="password" placeholder="Enter your password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Signing in...' : 'Open my dashboard'} <span aria-hidden="true">→</span></button>
    </form>
    <p className="form-footer">New to SalesSathi? <Link to="/signup">Create an account</Link></p>
  </AuthLayout>
}

function SignupPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ shop: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  function updateField(event) {
    setForm({ ...form, [event.target.name]: event.target.value })
    if (event.target.name === 'email') setEmailError('')
    if (event.target.name === 'password') setPasswordError('')
  }
  async function handleSubmit(event) {
    event.preventDefault()
    const normalizedEmail = form.email.trim().toLowerCase()
    if (!emailRegex.test(normalizedEmail)) {
      setEmailError('Enter a valid email address')
      return
    }
    if (form.password.length < 6) {
      setPasswordError('Password must be at least 6 characters')
      return
    }
    setForm({ ...form, email: normalizedEmail })
    setEmailError('')
    setPasswordError('')
    setError('')
    setIsSubmitting(true)
    const { data, error: authError } = await supabase.auth.signUp({ email: normalizedEmail, password: form.password })
    if (authError) {
      setError(authError.message)
      setIsSubmitting(false)
      return
    }

    if (!data.user) {
      setError('We could not create your account. Please try again.')
      setIsSubmitting(false)
      return
    }

    const { error: shopError } = await supabase.from('shops').insert({ name: form.shop })
    if (shopError) setError(shopError.message)
    else navigate('/dashboard')
    setIsSubmitting(false)
  }
  return <AuthLayout eyebrow="Start with clarity" title="A smarter day starts here." copy="Set up your shop in a minute and let SalesSathi turn everyday sales into useful advice.">
    <div className="form-heading"><p className="eyebrow">Create account</p><h2>Set up your shop</h2><p>We&apos;ll use this to personalize your daily view.</p></div>
    <form onSubmit={handleSubmit}>
      <label htmlFor="shop-name">Shop name</label>
      <input id="shop-name" name="shop" type="text" placeholder="e.g. Bhat-Bhateni Corner" value={form.shop} onChange={updateField} required />
      <label htmlFor="signup-email">Email address</label>
      <input id="signup-email" name="email" type="email" placeholder="you@example.com" value={form.email} onChange={updateField} required />
      {emailError && <p className="field-error" role="alert">{emailError}</p>}
      <label htmlFor="signup-password">Password</label>
      <input id="signup-password" name="password" type="password" placeholder="At least 6 characters" minLength="6" value={form.password} onChange={updateField} required />
      {passwordError && <p className="field-error" role="alert">{passwordError}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating account...' : 'Create my account'} <span aria-hidden="true">→</span></button>
    </form>
    <p className="form-footer">Already have an account? <Link to="/login">Sign in</Link></p>
  </AuthLayout>
}

function StatCard({ label, value, detail, tone }) {
  const icon = tone === 'sales' ? '↗' : tone === 'items' ? '◈' : '◎'
  return <article className={`stat-card ${tone}`}><div className="stat-icon" aria-hidden="true">{icon}</div><p>{label}</p><strong>{value}</strong><span>{detail}</span></article>
}

function SalesHistoryChart({ selectedProduct, monthlySales }) {
  if (monthlySales.length === 0) return <div className="empty-state chart-empty-state">No sales yet, upload a CSV</div>

  const chartData = {
    labels: monthlySales.map((item) => item.month),
    datasets: [
      { label: 'Actual quantity', data: monthlySales.map((item) => item.actual), borderColor: '#157a52', backgroundColor: 'rgba(21, 122, 82, .1)', fill: true, tension: .35, pointRadius: 4, pointBackgroundColor: '#157a52', spanGaps: true },
      { label: `${selectedProduct} forecast`, data: monthlySales.map((item) => item.forecast), borderColor: '#d39a37', borderDash: [7, 6], backgroundColor: 'transparent', tension: .35, pointRadius: 0, pointHoverRadius: 5, spanGaps: true },
    ],
  }
  const options = { responsive: true, maintainAspectRatio: false, interaction: { intersect: false, mode: 'index' }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => ` ${Number(context.raw).toLocaleString('en-IN')} units` } } }, scales: { x: { grid: { display: false }, ticks: { color: '#84988d', font: { size: 11 } } }, y: { beginAtZero: true, grid: { color: '#edf3ee' }, ticks: { color: '#84988d', font: { size: 10 }, callback: (value) => `${value} units` } } } }
  return <div className="line-chart"><Line data={chartData} options={options} /></div>
}

function DashboardPage({ user }) {
  const [selectedProduct, setSelectedProduct] = useState('')
  const [products, setProducts] = useState([])
  const [sales, setSales] = useState([])
  const [forecasts, setForecasts] = useState([])
  const [isLoadingData, setIsLoadingData] = useState(true)
  const [dataError, setDataError] = useState('')
  const [dataVersion, setDataVersion] = useState(0)
  const [csvRows, setCsvRows] = useState([])
  const [confirmedCsvRows, setConfirmedCsvRows] = useState([])
  const [csvFileName, setCsvFileName] = useState('')
  const [csvError, setCsvError] = useState('')
  const [csvStatus, setCsvStatus] = useState('')
  const [isImportingCsv, setIsImportingCsv] = useState(false)
  const [shop, setShop] = useState(null)
  const [shopError, setShopError] = useState('')
  const [demoStatus, setDemoStatus] = useState('')
  const [isLoadingDemo, setIsLoadingDemo] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    let isMounted = true

    async function fetchShop() {
      setIsLoadingData(true)
      setDataError('')
      const { data, error } = await supabase
        .from('shops')
        .select('id, name')
        .eq('owner_id', user.id)
        .maybeSingle()

      if (!isMounted) return
      if (error) {
        setShopError(error.message)
        setDataError(error.message)
        setIsLoadingData(false)
        return
      }
      setShop(data)
      if (!data?.id) {
        setDataError('No shop is connected to this account yet.')
        setIsLoadingData(false)
        return
      }

      const [{ data: productRows, error: productsError }, { data: salesRows, error: salesError }] = await Promise.all([
        supabase.from('products').select('id, name').eq('shop_id', data.id).order('name'),
        supabase.from('sales').select('product_id, sold_on, quantity, price, discount').eq('shop_id', data.id).order('sold_on'),
      ])

      if (!isMounted) return
      if (productsError || salesError) {
        setDataError(productsError?.message || salesError?.message || 'Could not load shop data.')
        setIsLoadingData(false)
        return
      }
      const forecastPayload = buildForecastRows(data.id, productRows || [], salesRows || [])
      let forecastRows = []
      if (forecastPayload.length > 0) {
        const { data: savedForecasts, error: forecastsError } = await supabase
          .from('forecasts')
          .upsert(forecastPayload, { onConflict: 'product_id,target_month' })
          .select('shop_id, product_id, target_month, predicted_qty, change_pct, advice')
        if (forecastsError) {
          setDataError(forecastsError.message)
          setIsLoadingData(false)
          return
        }
        forecastRows = savedForecasts || []
      }
      setProducts(productRows || [])
      setSales(salesRows || [])
      setForecasts(forecastRows)
      setSelectedProduct((currentProduct) => currentProduct && productRows?.some((product) => product.name === currentProduct) ? currentProduct : productRows?.[0]?.name || '')
      setIsLoadingData(false)
    }

    fetchShop()
    return () => { isMounted = false }
  }, [user.id, dataVersion])

  function handleCsvUpload(event) {
    const [file] = event.target.files
    if (!file) return

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = (results.meta.fields || []).map((field) => field.trim().toLowerCase())
        const missingColumns = expectedCsvColumns.filter((column) => !fields.includes(column))
        if (missingColumns.length > 0) {
          setCsvRows([])
          setConfirmedCsvRows([])
          setCsvFileName('')
          setCsvError(`Missing required column${missingColumns.length > 1 ? 's' : ''}: ${missingColumns.join(', ')}`)
          return
        }

        const normalizedRows = results.data.map((row) => expectedCsvColumns.reduce((normalizedRow, column) => {
          const sourceColumn = fields.find((field) => field === column)
          normalizedRow[column] = String(row[sourceColumn] ?? '').trim()
          return normalizedRow
        }, {}))

        if (normalizedRows.length === 0) {
          setCsvRows([])
          setConfirmedCsvRows([])
          setCsvFileName('')
          setCsvError('This CSV does not contain any sales rows.')
          return
        }

        setCsvRows(normalizedRows)
        setConfirmedCsvRows([])
        setCsvFileName(file.name)
        setCsvStatus('')
        setCsvError(results.errors.length ? 'Some rows could not be read and may be incomplete.' : '')
      },
      error: () => setCsvError('We could not read that file. Please choose a valid CSV.'),
    })
    event.target.value = ''
  }

  async function confirmCsvImport() {
    if (!shop?.id || isImportingCsv) return
    setCsvError('')
    setCsvStatus('')

    const invalidRowIndex = csvRows.findIndex((row) => {
      const parsedDate = new Date(row.date)
      return !normalizeProductName(row.product) || Number.isNaN(parsedDate.getTime()) || !Number.isFinite(Number(row.quantity)) || Number(row.quantity) < 0 || !Number.isFinite(Number(row.price)) || Number(row.price) < 0 || !Number.isFinite(Number(row.discount || 0)) || Number(row.discount || 0) < 0
    })
    if (invalidRowIndex !== -1) {
      setCsvError(`Row ${invalidRowIndex + 1} has an invalid date, product, quantity, price, or discount.`)
      return
    }

    setIsImportingCsv(true)
    const { data: existingProducts, error: productsFetchError } = await supabase
      .from('products')
      .select('id, name')
      .eq('shop_id', shop.id)
    if (productsFetchError) {
      setCsvError(productsFetchError.message)
      setIsImportingCsv(false)
      return
    }

    const productsByNormalizedName = new Map((existingProducts || []).map((product) => [normalizeProductName(product.name), product]))
    const productNames = [...new Map(csvRows.map((row) => {
      const name = row.product.trim().replace(/\s+/g, ' ')
      return [normalizeProductName(name), name]
    })).values()]
    const missingProductNames = productNames.filter((name) => !productsByNormalizedName.has(normalizeProductName(name)))
    if (missingProductNames.length > 0) {
      const { data: insertedProducts, error: productsInsertError } = await supabase
        .from('products')
        .insert(missingProductNames.map((name) => ({ shop_id: shop.id, name })))
        .select('id, name')
      if (productsInsertError) {
        setCsvError(productsInsertError.message)
        setIsImportingCsv(false)
        return
      }
      insertedProducts.forEach((product) => productsByNormalizedName.set(normalizeProductName(product.name), product))
    }

    const productIds = new Map(productNames.map((name) => [normalizeProductName(name), productsByNormalizedName.get(normalizeProductName(name)).id]))
    const { data: existingSales, error: salesFetchError } = await supabase
      .from('sales')
      .select('product_id, sold_on, quantity, price')
      .eq('shop_id', shop.id)
    if (salesFetchError) {
      setCsvError(salesFetchError.message)
      setIsImportingCsv(false)
      return
    }

    const existingSaleKeys = new Set((existingSales || []).map((sale) => `${sale.product_id}|${sale.sold_on}|${sale.quantity}|${sale.price}`))
    const salesRows = csvRows.map((row) => ({
      shop_id: shop.id,
      product_id: productIds.get(normalizeProductName(row.product)),
      sold_on: formatLocalDate(new Date(row.date)),
      quantity: Number(row.quantity),
      price: Number(row.price),
      discount: Number(row.discount || 0),
    })).filter((row) => {
      const key = `${row.product_id}|${row.sold_on}|${row.quantity}|${row.price}`
      if (existingSaleKeys.has(key)) return false
      existingSaleKeys.add(key)
      return true
    })
    if (salesRows.some((row) => !row.product_id)) {
      setCsvError('Some imported products could not be matched to their sales rows.')
      setIsImportingCsv(false)
      return
    }

    for (let startIndex = 0; startIndex < salesRows.length; startIndex += 500) {
      const { error: salesError } = await supabase.from('sales').insert(salesRows.slice(startIndex, startIndex + 500))
      if (salesError) {
        setCsvError(salesError.message)
        setIsImportingCsv(false)
        return
      }
    }

    setConfirmedCsvRows(csvRows)
    setCsvStatus(salesRows.length > 0 ? `Imported ${salesRows.length} new sales rows. Forecasts are refreshing now.` : 'All previewed rows already exist in sales. Nothing new was imported.')
    setIsImportingCsv(false)
    setDataVersion((version) => version + 1)
  }

  async function loadDemoData() {
    if (!shop?.id) {
      setDemoStatus('Your shop could not be found yet. Please try again shortly.')
      return
    }

    setDemoStatus('')
    setIsLoadingDemo(true)
    const { count: salesCount, error: salesCheckError } = await supabase
      .from('sales')
      .select('id', { count: 'exact', head: true })
      .eq('shop_id', shop.id)

    if (salesCheckError) {
      setDemoStatus(salesCheckError.message)
      setIsLoadingDemo(false)
      return
    }

    if (salesCount > 0) {
      setDemoStatus('Demo data skipped because this shop already has sales.')
      setIsLoadingDemo(false)
      return
    }

    const { data: existingProducts, error: productsFetchError } = await supabase
      .from('products')
      .select('id, name')
      .eq('shop_id', shop.id)

    if (productsFetchError) {
      setDemoStatus(productsFetchError.message)
      setIsLoadingDemo(false)
      return
    }

    const existingByName = new Map((existingProducts || []).map((product) => [normalizeProductName(product.name), product]))
    const missingProducts = demoProducts.filter((product) => !existingByName.has(normalizeProductName(product.name)))
    let insertedProducts = []
    if (missingProducts.length > 0) {
      const { data, error: productsInsertError } = await supabase
        .from('products')
        .insert(missingProducts.map((product) => ({ shop_id: shop.id, name: product.name })))
        .select('id, name')

      if (productsInsertError) {
        setDemoStatus(productsInsertError.message)
        setIsLoadingDemo(false)
        return
      }
      insertedProducts = data || []
    }

    const productsWithIds = demoProducts.map((demoProduct) => ({
      ...demoProduct,
      id: existingByName.get(normalizeProductName(demoProduct.name))?.id || insertedProducts.find((product) => normalizeProductName(product.name) === normalizeProductName(demoProduct.name))?.id,
    }))
    if (productsWithIds.some((product) => !product.id)) {
      setDemoStatus('Demo products could not be prepared for sales.')
      setIsLoadingDemo(false)
      return
    }

    const { error: salesInsertError } = await supabase.from('sales').insert(buildDemoSales(shop.id, productsWithIds))
    setDemoStatus(salesInsertError ? salesInsertError.message : 'Demo data loaded: 6 products and 72 monthly sales rows added.')
    if (!salesInsertError) setDataVersion((version) => version + 1)
    setIsLoadingDemo(false)
  }

  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(now)
  const emailPrefix = user.email?.split('@')[0] || 'there'
  const latestMonth = sales.map((sale) => getMonthKey(sale.sold_on)).filter(Boolean).sort().at(-1) || ''
  const latestMonthKeys = getMonthKeysEndingAt(latestMonth, 3)
  const lastMonthRevenue = sales.filter((sale) => getMonthKey(sale.sold_on) === latestMonth).reduce((total, sale) => total + getSaleRevenue(sale), 0)
  const latestSaleByProduct = new Map()
  sales.forEach((sale) => {
    if (!latestSaleByProduct.has(sale.product_id) || sale.sold_on > latestSaleByProduct.get(sale.product_id).sold_on) latestSaleByProduct.set(sale.product_id, sale)
  })
  const forecastRevenue = forecasts.reduce((total, forecast) => {
    const latestSale = latestSaleByProduct.get(forecast.product_id)
    return total + (Number(forecast.predicted_qty) || 0) * (latestSale ? getSaleRevenue({ ...latestSale, quantity: 1 }) : 0)
  }, 0)
  const recommendations = forecasts.map((forecast) => {
    const product = products.find((item) => item.id === forecast.product_id)
    const quantities = latestMonthKeys.map((monthKey) => sales.filter((sale) => sale.product_id === forecast.product_id && getMonthKey(sale.sold_on) === monthKey).reduce((total, sale) => total + (Number(sale.quantity) || 0), 0))
    const average = quantities.reduce((total, quantity) => total + quantity, 0) / (quantities.length || 1)
    const changePct = Number(forecast.change_pct) || 0
    const tone = changePct >= 8 ? 'increase' : changePct <= -8 ? 'reduce' : 'keep'
    return { ...forecast, name: product?.name || 'Unknown product', average: `${Math.round(average)} units`, forecast: `${Math.round(Number(forecast.predicted_qty) || 0)} units`, trend: `${changePct >= 0 ? '↑' : '↓'} ${Math.abs(changePct)}%`, tone }
  })
  const selectedProductRecord = products.find((product) => product.name === selectedProduct)
  const selectedProductMonths = [...new Set(sales.filter((sale) => sale.product_id === selectedProductRecord?.id).map((sale) => getMonthKey(sale.sold_on)).filter(Boolean))].sort().slice(-12)
  const selectedForecast = forecasts.find((forecast) => forecast.product_id === selectedProductRecord?.id)
  const selectedProductMonthlySales = selectedProductMonths.map((monthKey) => ({ month: formatMonth(monthKey), actual: sales.filter((sale) => sale.product_id === selectedProductRecord?.id && getMonthKey(sale.sold_on) === monthKey).reduce((total, sale) => total + (Number(sale.quantity) || 0), 0), forecast: null }))
  const selectedProductRecommendation = recommendations.find((recommendation) => recommendation.name === selectedProduct)
  const hasSales = sales.length > 0
  if (selectedForecast) selectedProductMonthlySales.push({ month: formatMonth(selectedForecast.target_month), actual: null, forecast: Number(selectedForecast.predicted_qty) || 0 })

  return <div className="app-shell"><Navbar /><main className="dashboard dashboard-expanded">
    <div className="dashboard-heading"><div><p className="eyebrow">{dateLabel}</p><h1>{greeting}, {emailPrefix} <span aria-hidden="true">✦</span></h1><p className="subtitle">Here&apos;s what&apos;s happening at <strong>{shop?.name || 'Your shop'}</strong> today.</p>{shopError && <p className="dashboard-data-error" role="status">Shop details are temporarily unavailable.</p>}</div><div className="dashboard-actions"><button className="date-button" type="button"><span aria-hidden="true">▣</span> This month <span aria-hidden="true">⌄</span></button>{import.meta.env.DEV && !isLoadingData && sales.length === 0 && <button className="demo-button" type="button" onClick={loadDemoData} disabled={isLoadingDemo}>{isLoadingDemo ? 'Loading demo data...' : 'Load demo data'}</button>}</div></div>
    {demoStatus && <p className="demo-status" role="status">{demoStatus}</p>}
    <section className="summary-grid" aria-label="Forecast summary"><StatCard label="Forecast revenue" value={isLoadingData ? '...' : hasSales ? formatCurrency(forecastRevenue) : '—'} detail={hasSales ? 'From persisted next-month forecasts' : 'No sales yet'} tone="sales" /><StatCard label="Last month revenue" value={isLoadingData ? '...' : hasSales ? formatCurrency(lastMonthRevenue) : '—'} detail={latestMonth ? `Latest month: ${formatMonth(latestMonth)}` : 'No sales yet'} tone="items" /><StatCard label="Products to restock" value={isLoadingData ? '...' : hasSales ? String(recommendations.filter((item) => item.tone === 'increase').length).padStart(2, '0') : '—'} detail={hasSales ? 'Forecast change of +8% or more' : 'No sales yet'} tone="stock" /><StatCard label="Products to cut back" value={isLoadingData ? '...' : hasSales ? String(recommendations.filter((item) => item.tone === 'reduce').length).padStart(2, '0') : '—'} detail={hasSales ? 'Forecast change of -8% or less' : 'No sales yet'} tone="cutback" /></section>
    {dataError && <p className="dashboard-data-error" role="alert">{dataError}</p>}
    <section className="panel csv-panel"><div className="csv-heading"><div><p className="eyebrow">Bring your own sales</p><h2>Upload sales CSV</h2><p>Use date, product, quantity, price, and discount columns.</p></div><input ref={fileInputRef} id="sales-csv-upload" className="csv-file-input" type="file" accept=".csv,text/csv" onChange={handleCsvUpload} /><button className="upload-button" type="button" onClick={() => fileInputRef.current?.click()} disabled={isImportingCsv}><span aria-hidden="true">↑</span> Upload sales CSV</button></div>{csvError && <p className="csv-error" role="alert">{csvError}</p>}{csvStatus && <p className="csv-success" role="status">{csvStatus}</p>}{csvRows.length > 0 && <div className="csv-preview"><div className="preview-heading"><div><strong>{csvFileName}</strong><span>{csvRows.length} rows ready to review</span></div>{confirmedCsvRows.length === 0 ? <button className="confirm-button" type="button" onClick={confirmCsvImport} disabled={isImportingCsv}>{isImportingCsv ? 'Importing...' : 'Confirm import'}</button> : <span className="confirmed-label">✓ Imported and refreshing</span>}</div><div className="table-wrap"><table><thead><tr>{expectedCsvColumns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{csvRows.slice(0, 5).map((row, index) => <tr key={`${row.date}-${row.product}-${index}`}>{expectedCsvColumns.map((column) => <td key={column}>{row[column] || '—'}</td>)}</tr>)}</tbody></table></div><p className="preview-note">Previewing the first {Math.min(csvRows.length, 5)} of {csvRows.length} rows. Nothing is saved to a server.</p></div>}</section>
    <section className="panel history-panel"><div className="panel-heading"><div><p className="eyebrow">Quantity forecast</p><h2>Monthly sales history</h2></div><label className="product-picker">Product<select value={selectedProduct} onChange={(event) => setSelectedProduct(event.target.value)} disabled={products.length === 0}><option value="">{isLoadingData ? 'Loading products...' : 'No products yet'}</option>{products.map((product) => <option key={product.id} value={product.name}>{product.name}</option>)}</select></label></div><div className="chart-legend"><span><i className="legend-dot actual" /> Actual quantity</span><span><i className="legend-dot forecast" /> Forecast quantity</span></div><SalesHistoryChart selectedProduct={selectedProduct || 'Selected product'} monthlySales={selectedProductMonthlySales} /><p className="chart-note">{selectedProduct ? `Showing Supabase quantities for ${selectedProduct.toLowerCase()}.` : 'Add products and sales to see a monthly history.'}</p></section>
    <section className="panel recommendations-panel"><div className="panel-heading"><div><p className="eyebrow">Stock planning</p><h2>Product recommendations</h2></div><span className="table-note">{hasSales ? 'Persisted forecasts' : 'Waiting for sales data'}</span></div><div className="table-wrap"><table><thead><tr><th>Product</th><th>Last 3-month avg</th><th>Forecast</th><th>Trend</th><th>Advice</th></tr></thead><tbody>{hasSales ? recommendations.map((item) => <tr key={item.product_id}><td><strong>{item.name}</strong></td><td>{item.average}</td><td>{item.forecast}</td><td className={`trend ${item.tone}`}>{item.trend}</td><td><span className={`advice-pill ${item.tone}`}>{item.advice}</span></td></tr>) : <tr><td colSpan="5" className="empty-table-cell">No sales yet, upload a CSV</td></tr>}</tbody></table></div>{selectedProductRecommendation && <p className="mobile-selection">Selected product: <strong>{selectedProductRecommendation.name}</strong> · {selectedProductRecommendation.advice}</p>}</section>
  </main></div>
}

function ProtectedRoute({ user, isLoading }) {
  if (isLoading) return <div className="auth-loading">Checking your session...</div>
  return user ? <DashboardPage user={user} /> : <Navigate to="/login" replace />
}

function App() {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let isMounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (isMounted) {
        setUser(data.session?.user ?? null)
        setIsLoading(false)
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setIsLoading(false)
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  return <BrowserRouter><Routes><Route path="/" element={<Navigate to="/login" replace />} /><Route path="/login" element={<LoginPage />} /><Route path="/signup" element={<SignupPage />} /><Route path="/dashboard" element={<ProtectedRoute user={user} isLoading={isLoading} />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes></BrowserRouter>
}

export default App
