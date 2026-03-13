interface LineSeries {
  label: string;
  color: string;
  values: Array<number | null>;
}

interface VibeLineChartProps {
  title: string;
  labels: string[];
  series: LineSeries[];
  yMin?: number;
  yMax?: number;
  valueSuffix?: string;
}

function createPath(values: Array<number | null>, min: number, max: number, width: number, height: number): string {
  if (values.length === 0) {
    return "";
  }

  const left = 28;
  const right = width - 14;
  const top = 14;
  const bottom = height - 24;
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);
  const denominator = Math.max(1, max - min);

  let path = "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null || !Number.isFinite(value)) {
      continue;
    }

    const x = left + (index / Math.max(1, values.length - 1)) * plotWidth;
    const y = top + ((max - value) / denominator) * plotHeight;

    const previous = values[index - 1];
    if (index === 0 || previous === null || !Number.isFinite(previous)) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)} `;
      continue;
    }

    path += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
  }

  return path.trim();
}

export function VibeLineChart(props: VibeLineChartProps) {
  const width = 960;
  const height = 240;
  const suffix = props.valueSuffix ?? "";

  const points = props.series.flatMap((item) =>
    item.values.filter((value): value is number => value !== null && Number.isFinite(value))
  );

  const min = props.yMin ?? (points.length > 0 ? Math.min(...points) : 0);
  const max = props.yMax ?? (points.length > 0 ? Math.max(...points) : 1);
  const resolvedMax = max === min ? max + 1 : max;

  return (
    <article className="vibe-chart-card">
      <header className="vibe-chart-header">
        <h3>{props.title}</h3>
        <div className="vibe-chart-legend">
          {props.series.map((item) => (
            <span key={item.label} className="legend-item">
              <i style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      </header>

      <svg className="vibe-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.title}>
        <rect x="0" y="0" width={width} height={height} fill="transparent" />
        {[0, 1, 2, 3, 4].map((slot) => {
          const y = 14 + (slot / 4) * (height - 38);
          return <line key={slot} x1={28} y1={y} x2={width - 14} y2={y} className="vibe-grid-line" />;
        })}
        {props.series.map((item) => {
          const path = createPath(item.values, min, resolvedMax, width, height);
          if (!path) {
            return null;
          }
          return <path key={item.label} d={path} stroke={item.color} fill="none" strokeWidth="2.4" />;
        })}
      </svg>

      <footer className="vibe-chart-footer">
        <span>
          Min: {min.toFixed(2)}
          {suffix}
        </span>
        <span>
          Max: {resolvedMax.toFixed(2)}
          {suffix}
        </span>
        <span>Points: {props.labels.length}</span>
      </footer>
    </article>
  );
}
