type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  strokeWidth?: number;
};

export function Sparkline({
  data,
  width = 320,
  height = 64,
  color = "#7c5cff",
  fill = true,
  strokeWidth = 2,
}: SparklineProps) {
  if (!data.length) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return [x, y];
  });

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${path} L ${width} ${height} L 0 ${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {fill && (
        <defs>
          <linearGradient id={`grad-${color}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={area} fill={`url(#grad-${color})`} />}
      <path d={path} stroke={color} strokeWidth={strokeWidth} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type BarChartProps = {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
};

export function BarChart({ data, width = 320, height = 64, color = "#7c5cff" }: BarChartProps) {
  const max = Math.max(...data) || 1;
  const barWidth = (width - (data.length - 1) * 3) / data.length;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      {data.map((v, i) => {
        const h = (v / max) * (height - 4);
        const x = i * (barWidth + 3);
        const y = height - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={2}
            fill={color}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}
