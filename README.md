# Counter App (Vite + React)

This is a simple counter app built with React and `useState`.
Use the `+` and `-` buttons to increment and decrement the value.

## Setup

1. Install dependencies

```bash
npm install
```

2. Start the development server

```bash
npm run dev
```

3. Open the URL shown in the terminal (usually `http://localhost:5173`)

## Analytics Filters

Open `http://localhost:5173/analytics` to view the dashboard.

- Period filter: `Last 1h`, `Last 24h`, `All`
- Operation filter (multi-select): `increment`, `decrement`, `reset`, `set`
- KPI cards and line chart are recalculated from the filtered dataset
