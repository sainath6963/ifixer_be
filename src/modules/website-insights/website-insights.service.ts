import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';

import { StoreSetting } from '../../database/schemas/operations.schema';
import {
  WebsiteEvent,
  WebsiteEventType,
  WebsiteTrafficDevice,
  WebsiteTrafficSource,
} from '../../database/schemas/website-event.schema';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import {
  analyticsBucketFormat,
  analyticsBucketKeys,
  metric,
  resolveAnalyticsPeriod,
} from '../admin-analytics/admin-analytics-period';
import type { ResolvedAnalyticsPeriod } from '../admin-analytics/admin-analytics.types';
import type { AdminAnalyticsQueryDto } from '../admin-analytics/dto/admin-analytics.dto';
import type { SaveGoogleReviewSettingDto, WebsiteEventDto } from './website-insights.dto';
import type { GoogleReviewSettingView, WebsiteInsightsOverview } from './website-insights.types';

const reviewSettingKey = 'repair.googleReviewUrl';
const retentionMs = 400 * 86_400_000;

interface TrafficSummary {
  pageViews: number;
  visits: number;
  uniqueVisitors: number;
}

interface TrendRow {
  _id: string;
  pageViews: number;
  sessions: string[];
  visitors: string[];
}

interface TopPageRow {
  _id: string;
  pageViews: number;
  sessions: string[];
}

interface SplitRow {
  _id: string;
  pageViews: number;
  sessions: string[];
}

export function canonicalGoogleReviewUrl(value: string): string {
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Enter a valid HTTPS Google review link');
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === 'g.page' ||
    host === 'goo.gl' ||
    host === 'maps.app.goo.gl' ||
    host === 'google.com' ||
    host.endsWith('.google.com');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed) {
    throw new BadRequestException(
      'Use an HTTPS Google Business review link from Google Search or Google Maps',
    );
  }
  return url.toString();
}

@Injectable()
export class WebsiteInsightsService {
  private readonly storefrontHost: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WebsiteEvent.name) private readonly events: Model<WebsiteEvent>,
    @InjectModel(StoreSetting.name) private readonly settings: Model<StoreSetting>,
    private readonly audit: AuthAuditService,
    config: ConfigService,
  ) {
    this.storefrontHost = new URL(config.getOrThrow<string>('PUBLIC_STOREFRONT_URL')).hostname;
  }

  async recordPageView(
    input: WebsiteEventDto,
    userAgent: string | undefined,
  ): Promise<{ recorded: boolean }> {
    return this.record(WebsiteEventType.PageView, input, userAgent);
  }

  async recordGoogleReviewClick(
    input: WebsiteEventDto,
    userAgent: string | undefined,
  ): Promise<{ recorded: boolean }> {
    return this.record(WebsiteEventType.GoogleReviewClick, input, userAgent);
  }

  async overview(query: AdminAnalyticsQueryDto): Promise<WebsiteInsightsOverview> {
    const period = resolveAnalyticsPeriod(query);
    const [
      current,
      previous,
      currentReviewClicks,
      previousReviewClicks,
      trend,
      topPages,
      sources,
      devices,
    ] = await Promise.all([
      this.summary(period.from, period.toExclusive),
      this.summary(period.previousFrom, period.previousToExclusive),
      this.eventCount(WebsiteEventType.GoogleReviewClick, period.from, period.toExclusive),
      this.eventCount(
        WebsiteEventType.GoogleReviewClick,
        period.previousFrom,
        period.previousToExclusive,
      ),
      this.trend(period),
      this.topPages(period),
      this.split(period, 'source'),
      this.split(period, 'device'),
    ]);

    return {
      period: {
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        timezone: period.timezone,
        days: period.days,
        granularity: period.granularity,
      },
      kpis: {
        pageViews: metric(current.pageViews, previous.pageViews),
        visits: metric(current.visits, previous.visits),
        uniqueVisitors: metric(current.uniqueVisitors, previous.uniqueVisitors),
        googleReviewClicks: metric(currentReviewClicks, previousReviewClicks),
      },
      trend: this.mergeTrend(period, trend),
      topPages: topPages.map((row) => ({
        path: row._id,
        pageViews: row.pageViews,
        visits: row.sessions.length,
      })),
      sources: sources.map((row) => ({ source: row._id, visits: row.sessions.length })),
      devices: devices.map((row) => ({
        device: row._id,
        pageViews: row.pageViews,
        visits: row.sessions.length,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  async reviewSetting(): Promise<GoogleReviewSettingView> {
    const row = await this.settings.findOne({ key: reviewSettingKey });
    const googleReviewUrl = typeof row?.value === 'string' ? row.value : '';
    return {
      googleReviewUrl,
      configured: Boolean(googleReviewUrl),
      version: row ? (row.get('version') as number) : 0,
    };
  }

  async publicReviewLink(): Promise<{ googleReviewUrl: string | null }> {
    const setting = await this.reviewSetting();
    return { googleReviewUrl: setting.googleReviewUrl || null };
  }

  async saveReviewSetting(
    input: SaveGoogleReviewSettingDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<GoogleReviewSettingView> {
    const googleReviewUrl = canonicalGoogleReviewUrl(input.googleReviewUrl);
    return this.connection.transaction(async (session) => {
      let row = await this.settings.findOne({ key: reviewSettingKey }).session(session);
      const version = row ? (row.get('version') as number) : 0;
      if (version !== input.expectedVersion) {
        throw new ConflictException('Google review settings changed. Refresh and try again.');
      }
      if (!row) {
        row = new this.settings({
          key: reviewSettingKey,
          value: googleReviewUrl,
          isPublic: true,
          description: 'Google Business review link displayed on the iFixer website',
          updatedBy: new Types.ObjectId(admin.id),
        });
      } else {
        row.value = googleReviewUrl;
        row.isPublic = true;
        row.description = 'Google Business review link displayed on the iFixer website';
        row.updatedBy = new Types.ObjectId(admin.id);
      }
      await row.save({ session });
      await this.audit.record(
        {
          action: googleReviewUrl ? 'GOOGLE_REVIEW_LINK_UPDATED' : 'GOOGLE_REVIEW_LINK_DISABLED',
          resourceType: 'WEBSITE_SETTING',
          resourceId: reviewSettingKey,
          actorId: admin.id,
          context,
        },
        session,
      );
      return {
        googleReviewUrl,
        configured: Boolean(googleReviewUrl),
        version: row.get('version') as number,
      };
    });
  }

  private async record(
    eventType: WebsiteEventType,
    input: WebsiteEventDto,
    userAgent: string | undefined,
  ): Promise<{ recorded: boolean }> {
    if (this.isBot(userAgent) || input.path === '/admin' || input.path.startsWith('/admin/')) {
      return { recorded: false };
    }
    const now = new Date();
    const referrer = this.referrer(input.referrer);
    await this.events.create({
      eventType,
      visitorHash: this.hash(input.visitorId),
      sessionHash: this.hash(input.sessionId),
      path: input.path,
      source: referrer.source,
      referrerHost: referrer.host,
      device: this.device(input.viewportWidth, userAgent),
      recordedAt: now,
      expiresAt: new Date(now.getTime() + retentionMs),
    });
    return { recorded: true };
  }

  private async summary(from: Date, to: Date): Promise<TrafficSummary> {
    const filter = {
      eventType: WebsiteEventType.PageView,
      recordedAt: { $gte: from, $lt: to },
    };
    const [pageViews, sessions, visitors] = await Promise.all([
      this.events.countDocuments(filter),
      this.events.distinct('sessionHash', filter),
      this.events.distinct('visitorHash', filter),
    ]);
    return { pageViews, visits: sessions.length, uniqueVisitors: visitors.length };
  }

  private eventCount(eventType: WebsiteEventType, from: Date, to: Date): Promise<number> {
    return this.events.countDocuments({ eventType, recordedAt: { $gte: from, $lt: to } }).exec();
  }

  private trend(period: ResolvedAnalyticsPeriod): Promise<TrendRow[]> {
    return this.events.aggregate<TrendRow>([
      {
        $match: {
          eventType: WebsiteEventType.PageView,
          recordedAt: { $gte: period.from, $lt: period.toExclusive },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: analyticsBucketFormat(period.granularity),
              date: '$recordedAt',
              timezone: '+05:30',
            },
          },
          pageViews: { $sum: 1 },
          sessions: { $addToSet: '$sessionHash' },
          visitors: { $addToSet: '$visitorHash' },
        },
      },
    ]);
  }

  private topPages(period: ResolvedAnalyticsPeriod): Promise<TopPageRow[]> {
    return this.events.aggregate<TopPageRow>([
      {
        $match: {
          eventType: WebsiteEventType.PageView,
          recordedAt: { $gte: period.from, $lt: period.toExclusive },
        },
      },
      { $group: { _id: '$path', pageViews: { $sum: 1 }, sessions: { $addToSet: '$sessionHash' } } },
      { $sort: { pageViews: -1, _id: 1 } },
      { $limit: 10 },
    ]);
  }

  private split(period: ResolvedAnalyticsPeriod, field: 'source' | 'device'): Promise<SplitRow[]> {
    return this.events.aggregate<SplitRow>([
      {
        $match: {
          eventType: WebsiteEventType.PageView,
          recordedAt: { $gte: period.from, $lt: period.toExclusive },
        },
      },
      {
        $group: {
          _id: `$${field}`,
          pageViews: { $sum: 1 },
          sessions: { $addToSet: '$sessionHash' },
        },
      },
      { $sort: { pageViews: -1, _id: 1 } },
    ]);
  }

  private mergeTrend(
    period: ResolvedAnalyticsPeriod,
    rows: TrendRow[],
  ): Array<{ key: string; pageViews: number; visits: number; uniqueVisitors: number }> {
    const byKey = new Map(rows.map((row) => [row._id, row]));
    return analyticsBucketKeys(period).map((key) => {
      const row = byKey.get(key);
      return {
        key,
        pageViews: row?.pageViews ?? 0,
        visits: row?.sessions.length ?? 0,
        uniqueVisitors: row?.visitors.length ?? 0,
      };
    });
  }

  private referrer(value: string): { host: string; source: WebsiteTrafficSource } {
    if (!value) return { host: '', source: WebsiteTrafficSource.Direct };
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
      const host = url.hostname.toLowerCase().slice(0, 253);
      if (!host || host.replace(/^www\./, '') === this.storefrontHost.replace(/^www\./, '')) {
        return { host: '', source: WebsiteTrafficSource.Direct };
      }
      if (host === 'google.com' || host.endsWith('.google.com')) {
        return { host, source: WebsiteTrafficSource.Google };
      }
      if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
        return { host, source: WebsiteTrafficSource.Instagram };
      }
      if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
        return { host, source: WebsiteTrafficSource.Facebook };
      }
      if (host === 'whatsapp.com' || host.endsWith('.whatsapp.com') || host === 'wa.me') {
        return { host, source: WebsiteTrafficSource.WhatsApp };
      }
      return { host, source: WebsiteTrafficSource.Other };
    } catch {
      return { host: '', source: WebsiteTrafficSource.Direct };
    }
  }

  private device(width: number, userAgent: string | undefined): WebsiteTrafficDevice {
    if (width <= 767 || /mobile|iphone|android.+mobile/i.test(userAgent ?? '')) {
      return WebsiteTrafficDevice.Mobile;
    }
    if (width <= 1100 || /ipad|tablet|android/i.test(userAgent ?? '')) {
      return WebsiteTrafficDevice.Tablet;
    }
    return WebsiteTrafficDevice.Desktop;
  }

  private isBot(userAgent: string | undefined): boolean {
    return !userAgent || /bot|crawler|spider|headless|slurp|lighthouse|preview/i.test(userAgent);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
