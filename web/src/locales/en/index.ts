import accounts from './accounts.json';
import app from './app.json';
import assetCard from './assetCard.json';
import assets from './assets.json';
import common from './common.json';
import errors from './errors.json';
import opportunities from './opportunities.json';
import pairTicket from './pairTicket.json';
import trade from './trade.json';

/**
 * One bucket per screen area: `t('pairTicket.confirm')` reads
 * `pairTicket.json`. English is the source of the key types, so a key that
 * exists only in another language fails the typecheck, and one missing from
 * another language fails `locales.test.ts`.
 */
const en = { accounts, app, assetCard, assets, common, errors, opportunities, pairTicket, trade };

export default en;
