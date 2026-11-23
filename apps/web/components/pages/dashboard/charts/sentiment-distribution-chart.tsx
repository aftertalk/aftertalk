'use client';

import { PieChartIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Cell, Label, Pie, PieChart } from 'recharts';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { i18n } from '@/i18n/constants';
import type { DashboardSentimentResult } from '@/lib/action/dashboard';

const SENTIMENT_COLORS = {
  positive: '#10B981',
  neutral: '#F59E0B',
  negative: '#EF4444',
} as const;

interface SentimentDistributionChartProps {
  data: DashboardSentimentResult;
}

export function SentimentDistributionChart({ data }: SentimentDistributionChartProps) {
  const t = useTranslations();

  const { distribution } = data;
  const total = distribution.positive + distribution.neutral + distribution.negative;
  const isEmpty = total === 0;

  const chartConfig = {
    positive: { label: t(i18n.dashboard.sentimentDistribution.positive), color: SENTIMENT_COLORS.positive },
    neutral: { label: t(i18n.dashboard.sentimentDistribution.neutral), color: SENTIMENT_COLORS.neutral },
    negative: { label: t(i18n.dashboard.sentimentDistribution.negative), color: SENTIMENT_COLORS.negative },
  } satisfies ChartConfig;

  const pieData = [
    { name: 'positive', value: distribution.positive, fill: SENTIMENT_COLORS.positive },
    { name: 'neutral', value: distribution.neutral, fill: SENTIMENT_COLORS.neutral },
    { name: 'negative', value: distribution.negative, fill: SENTIMENT_COLORS.negative },
  ].filter((d) => d.value > 0);

  if (isEmpty) {
    return (
      <Card className="relative overflow-hidden">
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t(i18n.dashboard.sentimentDistribution.title)}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <PieChartIcon className="text-muted-foreground mb-4 h-10 w-10 opacity-40" />
          <p className="text-muted-foreground text-sm">{t(i18n.dashboard.sentimentDistribution.empty)}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="relative overflow-hidden">
      <CardHeader>
        <CardTitle className="text-sm">{t(i18n.dashboard.sentimentDistribution.title)}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <PieChart accessibilityLayer>
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="name"
              innerRadius={60}
              outerRadius={100}
              label={({ value }) => `${Math.round((value / total) * 100)}%`}
            >
              {pieData.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
              <Label
                content={({ viewBox }) => {
                  if (viewBox && 'cx' in viewBox && 'cy' in viewBox) {
                    return (
                      <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                        <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-2xl">
                          {total}
                        </tspan>
                        <tspan x={viewBox.cx} y={(viewBox.cy ?? 0) + 20} className="fill-muted-foreground text-xs">
                          {t(i18n.dashboard.callVolume.calls)}
                        </tspan>
                      </text>
                    );
                  }
                }}
              />
            </Pie>
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
          </PieChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
