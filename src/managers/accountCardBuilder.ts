/**
 * AccountCardBuilder — Pure function module for constructing pre-processed account cards.
 * No state, no side effects, easily testable. Renderer does zero logic.
 */

import { AccountQuota, AccountCard, ModelCard, LocalQuotaData } from '../types';
import { shortModelName, normalizeModelKey } from '../shared/helpers';
import { parseUserTier } from '../utils/lsTypes';

/**
 * Build a normKey → LS label lookup map from local protobuf data.
 * This is the "Rosetta Stone" that bridges LS enum IDs and API keys
 * to a single canonical label.
 *
 * Example map entries:
 *   "claudeopus46thinking" → "Claude Opus 4.6 (Thinking)"
 *   "gemini31prohigh"      → "Gemini 3.1 Pro (High)"
 */
function buildLabelMap(localData: LocalQuotaData | null): Map<string, string> {
    const map = new Map<string, string>();
    const configs = localData?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    for (const m of configs as any[]) {
        const label = m.label;
        if (!label) continue;
        // Index by normalized label (for matching against tracked API keys)
        map.set(normalizeModelKey(label), label);
    }
    return map;
}

/**
 * Resolve a tracked API key to the canonical LS label using the label map.
 * Uses exact normKey match first, then startsWith fallback for edge cases
 * like "claude-sonnet-4-6" matching "Claude Sonnet 4.6 (Thinking)".
 */
function resolveLabel(apiKey: string, labelMap: Map<string, string>): string {
    const norm = normalizeModelKey(apiKey);

    // 1. Exact normKey match
    const exact = labelMap.get(norm);
    if (exact) return exact;

    // 2. startsWith fallback: tracked key might be a prefix of LS label
    //    e.g. "claudesonnet46" (from "claude-sonnet-4-6")
    //    vs   "claudesonnet46thinking" (from "Claude Sonnet 4.6 (Thinking)")
    for (const [normLabel, label] of labelMap) {
        if (normLabel.startsWith(norm) || norm.startsWith(normLabel)) {
            return label;
        }
    }

    // 3. No match → fallback to shortModelName (existing behavior)
    return shortModelName(apiKey);
}

/**
 * Classify a model label into a display family.
 * Returns 'gemini' | 'claude' | null (null = exclude).
 */
function modelFamily(label: string): 'gemini' | 'claude' | null {
    const l = label.toLowerCase();
    if (l.startsWith('gemini')) return 'gemini';
    if (l.startsWith('claude')) return 'claude';
    return null; // GPT-OSS and anything else → exclude
}

/**
 * Merge a raw model list into at most two entries: "Gemini" and "Claude".
 * Within each family, takes the minimum pct (worst quota) and earliest resetTime.
 * GPT-OSS and unrecognised models are dropped.
 */
function mergeModelGroups(models: ModelCard[]): ModelCard[] {
    const groups: Record<string, ModelCard> = {};
    for (const m of models) {
        const fam = modelFamily(m.label);
        if (!fam) continue;
        const displayLabel = fam === 'gemini' ? 'Gemini' : 'Claude';
        const existing = groups[fam];
        if (!existing) {
            groups[fam] = { ...m, label: displayLabel };
        } else {
            // ponytail: keep worst pct, earliest reset
            if (m.pct < existing.pct) {
                groups[fam] = { ...m, label: displayLabel };
            }
        }
    }
    // Stable order: Gemini first, Claude second
    const result: ModelCard[] = [];
    if (groups['gemini']) result.push(groups['gemini']);
    if (groups['claude']) result.push(groups['claude']);
    return result;
}

export function buildAccountCards(
    localData: LocalQuotaData | null,
    trackedQuotas: AccountQuota[],
    activeEmailRaw: string,
    switchActive: boolean,
    selectedModels: string[],
): AccountCard[] {
    const activeEmail = (activeEmailRaw || '').toLowerCase();
    const cards: AccountCard[] = [];

    // Build label map from local LS data (Rosetta Stone for cross-source pin matching)
    const labelMap = buildLabelMap(localData);

    const status = localData?.userStatus;
    const localEmail = (status?.email || '').toLowerCase();

    if (status) {
        const rawModels = (status.cascadeModelConfigData?.clientModelConfigs || [])
            .filter((m: any) => m.quotaInfo)
            .sort((a: any, b: any) => (a.label || '').localeCompare(b.label || ''));

        const rawMapped: ModelCard[] = rawModels.map((m: any) => ({
            id: m.modelOrAlias?.model || m.label,
            label: m.label || shortModelName(m.modelOrAlias?.model),
            pct: m.quotaInfo.remainingFraction !== undefined
                ? Math.max(0, Math.min(100, Math.round(m.quotaInfo.remainingFraction * 100)))
                : 0,
            resetTime: m.quotaInfo.resetTime || '',
            isLocal: true,
        }));
        const models = mergeModelGroups(rawMapped);

        const userTier = parseUserTier(status.userTier);

        // Intent email ≠ LS email → switch in progress, LS hasn't adopted new identity yet
        const isTransitioning = !!(
            activeEmail && localEmail &&
            activeEmail !== localEmail &&
            switchActive
        );

        const bottleneckMerged = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;
        cards.push({
            email: status.email || 'active-local',
            isActive: !activeEmail || activeEmail === localEmail,
            isTransitioning,
            pendingEmail: isTransitioning ? activeEmailRaw : undefined,
            models,
            bottleneck: bottleneckMerged,
            tierName: userTier.name,
            tierId: userTier.id,
            aiCredits: null,
            promptCredits: null,
            promptCreditsMax: null,
            flowCredits: null,
            flowCreditsMax: null,
            resetTime: bottleneckMerged?.resetTime || models[0]?.resetTime || '',
            isError: false,
            selectedModels,
            isLocal: true,
        });
    }

    // Dedup: skip tracked account if its email matches local card (local has richer data).
    // During switch A→B: local=A(stale), tracked A must still be deduped.
    const dedupEmail = localEmail || '';

    for (const trackedQuota of trackedQuotas) {
        const trackedEmail = (trackedQuota.account.email || '').toLowerCase();
        if (dedupEmail && trackedEmail === dedupEmail) continue;

        const rawTracked: ModelCard[] = (trackedQuota.models || []).map(m => ({
            id: m.name,
            label: resolveLabel(m.name, labelMap),
            pct: m.percentage || 0,
            resetTime: m.resetTimeRaw || m.resetTime || '',
            isLocal: false,
        }));
        const models = mergeModelGroups(rawTracked);

        const bottleneckModel = models.length > 0 ? models.reduce((a, b) => a.pct < b.pct ? a : b) : null;  // ponytail: bottleneck of merged groups

        cards.push({
            email: trackedQuota.account.email || 'Unknown',
            name: trackedQuota.account.name,
            isActive: !!(activeEmail && activeEmail === trackedEmail),
            trackingId: trackedQuota.account.id,
            models,
            bottleneck: bottleneckModel,
            tierName: trackedQuota.tierName || trackedQuota.tier || null,
            resetTime: bottleneckModel?.resetTime || '',
            isError: trackedQuota.isError || trackedQuota.isForbidden,
            errorMessage: trackedQuota.isForbidden ? 'Access forbidden' : (trackedQuota.errorMessage || ''),
            selectedModels: [],
            isLocal: false,
            aiCredits: null,
            promptCredits: null,
            promptCreditsMax: null,
            flowCredits: null,
            flowCreditsMax: null,
        });
    }

    // ponytail: sort priority — active first, then by token availability tier
    function sortTier(card: AccountCard): number {
        if (card.isActive) return 0;
        if (card.isError || card.models.length === 0) return 4;
        const available = card.models.filter(m => m.pct > 0).length;
        if (available === card.models.length) return 1; // all models have quota
        if (available > 0)                    return 2; // at least one model has quota
        return 3;                                       // all drained
    }
    cards.sort((a, b) => sortTier(a) - sortTier(b));
    return cards;
}
