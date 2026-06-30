import ReactECharts from 'echarts-for-react'
import type { PredictResult } from '../api'

function classCounts(results: PredictResult[]) {
  const order: PredictResult['suitability_class'][] = ['Low', 'Medium', 'High']
  const m: Record<string, number> = { Low: 0, Medium: 0, High: 0 }
  for (const r of results) m[r.suitability_class] = (m[r.suitability_class] || 0) + 1
  return order.map((k) => ({ k, v: m[k] || 0 }))
}

export function Charts({ results }: { results: PredictResult[] }) {
  const counts = classCounts(results)
  const resultLabels = results.map((_, index) => `Point ${index + 1}`)
  const rotateLabels = results.length > 8

  const optionMetrics = {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true },
    legend: { textStyle: { color: '#cbd5e1' } },
    xAxis: {
      type: 'category',
      data: resultLabels,
      axisLabel: { color: '#cbd5e1', interval: 0, rotate: rotateLabels ? 35 : 0, margin: 14 },
      axisTick: { alignWithLabel: true },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#cbd5e1' },
      splitLine: { lineStyle: { color: '#24324f' } },
    },
    grid: { left: 45, right: 20, top: 30, bottom: rotateLabels ? 72 : 48, containLabel: true },
    series: [
      {
        name: 'GPI',
        type: 'bar',
        data: results.map((r) => Number(r.gpi.toFixed(2))),
        itemStyle: { color: '#38bdf8' },
      },
      {
        name: 'Yield (m³/h)',
        type: 'bar',
        data: results.map((r) => Number(r.predicted_yield_m3h.toFixed(2))),
        itemStyle: { color: '#22c55e' },
      },
      {
        name: 'SWL (m)',
        type: 'bar',
        data: results.map((r) => Number(r.predicted_static_water_level_m.toFixed(2))),
        itemStyle: { color: '#f59e0b' },
      },
    ],
  }

  const optionClassBar = {
    animation: false,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, appendToBody: true },
    xAxis: {
      type: 'category',
      data: counts.map((c) => c.k),
      axisLabel: { color: '#cbd5e1' },
    },
    yAxis: { type: 'value', axisLabel: { color: '#cbd5e1' }, splitLine: { lineStyle: { color: '#24324f' } } },
    grid: { left: 40, right: 20, top: 20, bottom: 35 },
    series: [
      {
        type: 'bar',
        data: counts.map((c) => c.v),
        itemStyle: {
          color: (p: { dataIndex: number }) => ['#ef4444', '#f59e0b', '#22c55e'][p.dataIndex] ?? '#38bdf8',
        },
      },
    ],
  }

  const optionYieldVsGpi = {
    animation: false,
    tooltip: { trigger: 'item', appendToBody: true },
    xAxis: { type: 'value', name: 'GPI', axisLabel: { color: '#cbd5e1' }, splitLine: { lineStyle: { color: '#24324f' } } },
    yAxis: {
      type: 'value',
      name: 'Yield (m³/h)',
      axisLabel: { color: '#cbd5e1' },
      splitLine: { lineStyle: { color: '#24324f' } },
    },
    grid: { left: 55, right: 20, top: 20, bottom: 45 },
    series: [
      {
        type: 'scatter',
        symbolSize: 10,
        data: results.map((r) => [r.gpi, r.predicted_yield_m3h, r.decision]),
        itemStyle: {
          color: (p: { value: (number | string)[] }) => {
            const decision = String(p.value[2] ?? '')
            if (decision === 'Suitable') return '#22c55e'
            if (decision === 'Moderate') return '#f59e0b'
            return '#ef4444'
          },
        },
      },
    ],
  }

  const optionSwlVsGpi = {
    animation: false,
    tooltip: { trigger: 'item', appendToBody: true },
    xAxis: { type: 'value', name: 'GPI', axisLabel: { color: '#cbd5e1' }, splitLine: { lineStyle: { color: '#24324f' } } },
    yAxis: {
      type: 'value',
      name: 'SWL (m)',
      inverse: true,
      axisLabel: { color: '#cbd5e1' },
      splitLine: { lineStyle: { color: '#24324f' } },
    },
    grid: { left: 55, right: 20, top: 20, bottom: 45 },
    series: [
      {
        type: 'scatter',
        symbolSize: 10,
        data: results.map((r) => [r.gpi, r.predicted_static_water_level_m, r.decision]),
        itemStyle: {
          color: (p: { value: (number | string)[] }) => {
            const decision = String(p.value[2] ?? '')
            if (decision === 'Suitable') return '#22c55e'
            if (decision === 'Moderate') return '#f59e0b'
            return '#ef4444'
          },
        },
      },
    ],
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ border: '1px solid #2a3a5a', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.04)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Prediction metrics overview</div>
        <ReactECharts option={optionMetrics} style={{ height: 280 }} />
      </div>
      {results.length < 2 ? null : (
        <>
          <div style={{ border: '1px solid #2a3a5a', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Predicted suitability class distribution</div>
            <ReactECharts option={optionClassBar} style={{ height: 260 }} />
          </div>
          <div style={{ border: '1px solid #2a3a5a', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Predicted yield vs GPI</div>
            <ReactECharts option={optionYieldVsGpi} style={{ height: 280 }} />
          </div>
          <div style={{ border: '1px solid #2a3a5a', borderRadius: 12, padding: 10, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Static water level vs GPI</div>
            <ReactECharts option={optionSwlVsGpi} style={{ height: 280 }} />
          </div>
        </>
      )}
    </div>
  )
}
