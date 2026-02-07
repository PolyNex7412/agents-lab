import { useState } from "react";
import "./App.css";
import "./analytics.css";

const OPERATION_TYPES = ["increment", "decrement", "reset", "set"];
const NOW = Date.now();
const SAMPLE_HISTORY = [
  { step: 0, value: 4, op: "set", ts: NOW - 30 * 60 * 60 * 1000, initial: true },
  { step: 1, value: 7, op: "increment", ts: NOW - 20 * 60 * 60 * 1000 },
  { step: 2, value: 6, op: "decrement", ts: NOW - 90 * 60 * 1000 },
  { step: 3, value: 0, op: "reset", ts: NOW - 40 * 60 * 1000 },
  { step: 4, value: 11, op: "set", ts: NOW - 20 * 60 * 1000 },
  { step: 5, value: 12, op: "increment", ts: NOW - 5 * 60 * 1000 },
];
const INITIAL_COUNT = SAMPLE_HISTORY[SAMPLE_HISTORY.length - 1].value;

function App() {
  const [count, setCount] = useState(INITIAL_COUNT);
  const [history, setHistory] = useState(SAMPLE_HISTORY);
  const [period, setPeriod] = useState("all");
  const [operationFilter, setOperationFilter] = useState({
    increment: true,
    decrement: true,
    reset: true,
    set: true,
  });
  const [setValueText, setSetValueText] = useState("10");
  const isAnalytics = window.location.pathname === "/analytics";

  const recordValue = (nextValue, op) => {
    setHistory((prevHistory) => [
      ...prevHistory,
      { step: prevHistory.length, value: nextValue, op, ts: Date.now() },
    ]);
  };

  const updateCount = (delta, op) => {
    setCount((prev) => {
      const next = prev + delta;
      recordValue(next, op);
      return next;
    });
  };

  const resetCount = () => {
    setCount(() => {
      recordValue(0, "reset");
      return 0;
    });
  };

  const setCountDirectly = () => {
    const next = Number(setValueText);
    if (Number.isNaN(next)) return;
    setCount(() => {
      recordValue(next, "set");
      return next;
    });
  };

  const toggleOperation = (op) => {
    setOperationFilter((prev) => ({ ...prev, [op]: !prev[op] }));
  };

  const now = Date.now();
  const rangeMs =
    period === "1h" ? 60 * 60 * 1000 : period === "24h" ? 24 * 60 * 60 * 1000 : Number.POSITIVE_INFINITY;
  const filteredHistory = history.filter((point) => {
    const inRange = rangeMs === Number.POSITIVE_INFINITY || now - point.ts <= rangeMs;
    return inRange && operationFilter[point.op];
  });
  const dataset =
    filteredHistory.length > 0
      ? filteredHistory
      : [{ step: 0, value: 0, op: "set", ts: now, initial: true }];

  const totalOperations = filteredHistory.filter((point) => !point.initial).length;
  const averageValue =
    dataset.reduce((sum, point) => sum + point.value, 0) / dataset.length;
  const maxValue = dataset.reduce(
    (max, point) => (point.value > max ? point.value : max),
    Number.NEGATIVE_INFINITY
  );

  const chartWidth = 760;
  const chartHeight = 280;
  const padding = 32;
  const values = dataset.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxChartValue = Math.max(...values);
  const yRange = maxChartValue - minValue || 1;

  const points = dataset.map((point, index) => {
    const x =
      dataset.length === 1
        ? chartWidth / 2
        : padding +
          (index / (dataset.length - 1)) * (chartWidth - padding * 2);
    const y =
      padding +
      ((maxChartValue - point.value) / yRange) * (chartHeight - padding * 2);
    return { ...point, x, y };
  });
  const pathData = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");

  if (isAnalytics) {
    return (
      <main className="dashboard">
        <section className="analytics-header">
          <div>
            <h1>Analytics Dashboard</h1>
            <p className="subtitle">Counter operation timeline</p>
          </div>
          <div className="actions">
            <button type="button" onClick={() => updateCount(-1, "decrement")}>
              -
            </button>
            <span className="current-value">{count}</span>
            <button type="button" onClick={() => updateCount(1, "increment")}>
              +
            </button>
            <button type="button" onClick={resetCount}>
              Reset
            </button>
            <input
              type="number"
              value={setValueText}
              onChange={(event) => setSetValueText(event.target.value)}
            />
            <button type="button" onClick={setCountDirectly}>
              Set
            </button>
          </div>
        </section>

        <section className="kpi">
          <article>
            <p className="kpi-label">Total Operations</p>
            <p className="kpi-value">{totalOperations}</p>
          </article>
          <article>
            <p className="kpi-label">Average Value</p>
            <p className="kpi-value">{averageValue.toFixed(2)}</p>
          </article>
          <article>
            <p className="kpi-label">Max Value</p>
            <p className="kpi-value">{maxValue}</p>
          </article>
        </section>

        <section className="filters">
          <div className="period-filters">
            <button type="button" className={period === "1h" ? "active" : ""} onClick={() => setPeriod("1h")}>
              Last 1h
            </button>
            <button type="button" className={period === "24h" ? "active" : ""} onClick={() => setPeriod("24h")}>
              Last 24h
            </button>
            <button type="button" className={period === "all" ? "active" : ""} onClick={() => setPeriod("all")}>
              All
            </button>
          </div>
          <div className="operation-filters">
            {OPERATION_TYPES.map((op) => (
              <button
                key={op}
                type="button"
                className={operationFilter[op] ? "chip active" : "chip"}
                onClick={() => toggleOperation(op)}
              >
                {op}
              </button>
            ))}
          </div>
        </section>

        <section className="chart">
          <h2>Time Series</h2>
          <svg
            className="line-chart"
            viewBox={`0 0 ${chartWidth} ${chartHeight}`}
            role="img"
            aria-label="Counter time series line chart"
          >
            <path d={pathData} />
            {points.map((point, index) => (
              <circle key={`${point.step}-${index}`} cx={point.x} cy={point.y} r="4" />
            ))}
          </svg>
        </section>
      </main>
    );
  }

  return (
    <main className="counter-app">
      <h1>Counter App</h1>
      <p className="count">{count}</p>
      <div className="actions">
        <button type="button" onClick={() => updateCount(-1, "decrement")}>
          -
        </button>
        <button type="button" onClick={() => updateCount(1, "increment")}>
          +
        </button>
      </div>
      <a className="link" href="/analytics">
        Go to /analytics
      </a>
    </main>
  );
}

export default App;
