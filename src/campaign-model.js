export const MEDIA_TYPES = {
  IMAGE: 'image',
  VIDEO: 'video',
  MIXED: 'mixed',
};

export const URL_MODES = {
  PER_AD_AUTO: 'per_ad_auto',
  SHARED_MANUAL: 'shared_manual',
};

export function dateTokens(date = new Date(), timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    MMDD: `${values.month}${values.day}`,
    YYMMDD: `${values.year}${values.month}${values.day}`,
  };
}

export function renderTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in vars)) {
      throw new Error(`Unknown template variable: {${key}}`);
    }
    return String(vars[key]);
  });
}

export function getAdMediaType(adset, adIdx) {
  if (adset.mediaType === MEDIA_TYPES.IMAGE) return MEDIA_TYPES.IMAGE;
  if (adset.mediaType === MEDIA_TYPES.VIDEO) return MEDIA_TYPES.VIDEO;
  return Number(adIdx) === Number(adset.adCount) ? MEDIA_TYPES.VIDEO : MEDIA_TYPES.IMAGE;
}

export function buildAdUrl(adset, adIdx, adName, baseUrl) {
  if (adset.urlMode === URL_MODES.SHARED_MANUAL) {
    return adset.sharedLandingUrl;
  }
  const pathNum = adset.pathNumbers?.[adIdx - 1];
  return `${String(baseUrl || '').replace(/\/$/, '')}/${pathNum}?utm_source=f&utm_medium=f&utm_campaign=${adName}`;
}

export function buildAdsetPreview(config, adset, date = new Date()) {
  const tokens = dateTokens(date);
  const adsetName = renderTemplate(config.namingTemplate.adset, {
    ...tokens,
    idx: adset.index,
  });
  const ads = [];
  for (let adIdx = 1; adIdx <= adset.adCount; adIdx += 1) {
    const adName = renderTemplate(config.namingTemplate.ad, {
      ...tokens,
      idx: adset.index,
      ad_idx: adIdx,
      adset_name: adsetName,
    });
    ads.push({
      adIdx,
      mediaType: getAdMediaType(adset, adIdx),
      adName,
      url: buildAdUrl(adset, adIdx, adName, config.repurelyBaseUrl),
    });
  }
  return { adsetName, ads };
}

export function validateCampaignModel(config) {
  const errors = [];
  if (!config.adAccountId) errors.push('adAccountId is required.');
  if (!Number(config.dailyBudget) || Number(config.dailyBudget) <= 0) errors.push('dailyBudget must be greater than 0.');
  if (!/^\d{1,2}:\d{2}$/.test(String(config.scheduleTime || ''))) errors.push('scheduleTime must be HH:mm.');
  if (config.createNewCampaign) {
    if (!['CBO', 'ABO'].includes(config.campaignStructure)) errors.push('campaignStructure must be CBO or ABO.');
    if (!config.campaignName) errors.push('campaignName is required when createNewCampaign=true.');
    if (config.campaignStructure === 'CBO' && (!Number(config.campaignBudget) || Number(config.campaignBudget) <= 0)) {
      errors.push('campaignBudget must be greater than 0 for CBO.');
    }
  }
  if (!config.namingTemplate?.adset) errors.push('namingTemplate.adset is required.');
  if (!config.namingTemplate?.ad) errors.push('namingTemplate.ad is required.');
  if (!config.repurelyBaseUrl) errors.push('repurelyBaseUrl is required.');
  if (!Array.isArray(config.adsets) || !config.adsets.length) errors.push('At least one adset is required.');

  for (const adset of config.adsets || []) {
    const label = `adset ${adset.index}`;
    if (!['image', 'video', 'mixed'].includes(adset.mediaType)) errors.push(`${label}: mediaType is invalid.`);
    if (!Number.isInteger(Number(adset.adCount)) || Number(adset.adCount) < 1) errors.push(`${label}: adCount must be >= 1.`);
    if (adset.mediaType === MEDIA_TYPES.MIXED && Number(adset.adCount) < 2) errors.push(`${label}: mixed adCount must be >= 2.`);
    if ([MEDIA_TYPES.IMAGE, MEDIA_TYPES.MIXED].includes(adset.mediaType) && !adset.imageFolder) errors.push(`${label}: imageFolder is required.`);
    if ([MEDIA_TYPES.VIDEO, MEDIA_TYPES.MIXED].includes(adset.mediaType) && !adset.videoFolder) errors.push(`${label}: videoFolder is required.`);
    if (adset.urlMode === URL_MODES.PER_AD_AUTO) {
      if (!Array.isArray(adset.pathNumbers) || adset.pathNumbers.length !== Number(adset.adCount)) {
        errors.push(`${label}: pathNumbers length must match adCount.`);
      }
    } else if (adset.urlMode === URL_MODES.SHARED_MANUAL) {
      if (!String(adset.sharedLandingUrl || '').trim()) errors.push(`${label}: sharedLandingUrl is required.`);
    } else {
      errors.push(`${label}: urlMode is invalid.`);
    }
  }

  return errors;
}

