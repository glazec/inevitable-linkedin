import { API_URLS, identityIndex, matchPerson, personInput, pairKey, stableId } from './core.js';

export const PERSON_FIELDS = 'id name { firstName lastName } linkedinLink { primaryLinkUrl secondaryLinks } emails { primaryEmail additionalEmails }';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export class CRM {
  constructor({apiUrl, token}, fetcher = fetch, pace = 850) {
    if (!API_URLS.includes(apiUrl)) throw new Error('Unsupported CRM endpoint.');
    if (!token?.trim()) throw new Error('Add your CRM API key in Settings.');
    this.url = apiUrl; this.token = token.trim().replace(/^Bearer\s+/i,''); this.fetcher = (...args) => fetcher(...args); this.pace = pace; this.last = 0;
  }
  async query(query, variables = {}) {
    await wait(Math.max(0, this.pace - (Date.now() - this.last)));
    this.last = Date.now();
    let response;
    try {
      response = await this.fetcher(this.url + '/graphql', {
        method:'POST', credentials:'omit', redirect:'error',
        headers:{'Content-Type':'application/json', Authorization:`Bearer ${this.token}`},
        body:JSON.stringify({query,variables}), signal:AbortSignal.timeout(25000),
      });
    } catch { throw new Error('CRM request did not finish. Import paused. Resume will check for saved records before retrying.'); }
    if (!response.ok) {
      const messages = {401:'CRM API key expired or is invalid.',403:'CRM denied access. Check the key permissions or select the verified Railway endpoint in Settings.',429:'CRM rate limit reached. Wait one minute, then resume.'};
      throw new Error(messages[response.status] || `CRM returned HTTP ${response.status}. Import paused.`);
    }
    const body = await response.json();
    if (body.errors?.length) {
      // Never echo raw server errors; they may contain contact data or authentication details.
      throw new Error('CRM rejected the operation. Check API permissions and schema compatibility. Import paused.');
    }
    if (!body.data || typeof body.data !== 'object') throw new Error('CRM returned an incomplete response.');
    return body.data;
  }
  async all(plural, selection, filter = null, onPage = () => {}) {
    const records = [], cursors = new Set(); let cursor = null;
    do {
      const args = `first:100${cursor ? ', after:' + JSON.stringify(cursor) : ''}${filter ? ', filter:' + filter : ''}`;
      const data = await this.query(`{ ${plural}(${args}) { edges { node { ${selection} } } pageInfo { hasNextPage endCursor } } }`);
      const connection = data[plural];
      if (!Array.isArray(connection?.edges) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') throw new Error('CRM pagination response is incomplete. No import was started.');
      records.push(...connection.edges.map(e => e.node));
      await onPage(records.length);
      if (!connection.pageInfo.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) throw new Error('CRM pagination stalled. No import was started.');
      cursors.add(cursor);
    } while (true);
    return records;
  }
  async byId(plural, id, fields = 'id') {
    return (await this.all(plural,fields,`{id:{eq:${JSON.stringify(id)}}}`))[0] || null;
  }
  async create(singular, type, data, fields = 'id') {
    const key = 'create' + singular[0].toUpperCase() + singular.slice(1);
    const result = await this.query(`mutation($data:${type}!) { ${key}(data:$data) { ${fields} } }`,{data});
    if (!result[key]?.id) throw new Error('CRM did not confirm a saved record. Resume to reconcile.');
    return result[key];
  }
  async ensurePerson(row) {
    if (row.personId) {
      const existing = await this.byId('people',row.personId,PERSON_FIELDS);
      if (!existing) throw new Error('A matched CRM person was removed. Prepare a new preview.');
      const match = matchPerson(row, identityIndex([existing]));
      if (match.action !== 'existing') throw new Error('A matched contact changed identity. Prepare a new preview.');
      return existing.id;
    }
    const id = await stableId('person:' + (row.linkedinUrl || row.email));
    const saved = await this.byId('people',id,PERSON_FIELDS);
    if (saved) {
      if (matchPerson(row,identityIndex([saved])).action !== 'existing') throw new Error('Saved contact identity conflicts with this import.');
      return saved.id;
    }
    // Fresh check catches records added since the preview. The full preview also
    // indexes historical URL formats and secondary links / emails.
    const clauses = [];
    if (row.linkedinUrl) {
      const bare = row.linkedinUrl.replace('https://www.','');
      const variants = [row.linkedinUrl,row.linkedinUrl+'/',`https://${bare}`,`https://${bare}/`,`http://www.${bare}`,bare];
      for (const url of variants) clauses.push(`{linkedinLink:{primaryLinkUrl:{eq:${JSON.stringify(url)}}}}`);
    }
    if (row.email) clauses.push(`{emails:{primaryEmail:{eq:${JSON.stringify(row.email)}}}}`);
    const candidates = await this.all('people',PERSON_FIELDS,`{or:[${clauses.join(',')}]}`);
    const match = matchPerson(row,identityIndex(candidates));
    if (match.action === 'review') throw new Error(match.reason);
    if (match.personId) return match.personId;
    await this.create('person','PersonCreateInput',personInput(row,id));
    if (!await this.byId('people',id)) throw new Error('Person write could not be read back. Resume to reconcile.');
    return id;
  }
  async ensureRelationship(ownerId, personId, row, collectedAt) {
    if (!ownerId || ownerId === personId) return null;
    const pair = pairKey(ownerId,personId);
    const existing = await this.all('socialConnections','id personId connectedPersonId pairKey',`{or:[{pairKey:{eq:${JSON.stringify(pair)}}},{and:[{personId:{eq:${JSON.stringify(ownerId)}}},{connectedPersonId:{eq:${JSON.stringify(personId)}}}]},{and:[{personId:{eq:${JSON.stringify(personId)}}},{connectedPersonId:{eq:${JSON.stringify(ownerId)}}}]}]}`);
    if (existing.length > 1) throw new Error('Multiple relationship records exist for this pair. Review them in CRM.');
    if (existing[0] && pairKey(existing[0].personId,existing[0].connectedPersonId) !== pair) throw new Error('Relationship pair key conflicts with its participants. Review it in CRM.');
    const id = existing[0]?.id || await stableId('relationship:' + pair);
    if (!existing.length && !await this.byId('socialConnections',id)) {
      await this.create('socialConnection','SocialConnectionCreateInput',{
        id, pairKey:pair, personId:ownerId, connectedPersonId:personId,
        name:'LinkedIn connection', platforms:['LINKEDIN'], evidenceStatus:'VERIFIED',
        lastSeen:collectedAt,
        interactionSummary:`Imported from the owner's LinkedIn connections.${row.connectedOn ? ' Connected on: ' + row.connectedOn + '.' : ''}`,
        ...(row.linkedinUrl ? {evidenceUrls:{primaryLinkLabel:'LinkedIn profile', primaryLinkUrl:row.linkedinUrl}} : {}),
      });
      if (!await this.byId('socialConnections',id)) throw new Error('Relationship could not be read back.');
    }
    for (const member of [ownerId,personId]) {
      const participants = await this.all('socialConnectionParticipants','id',`{and:[{socialConnectionId:{eq:${JSON.stringify(id)}}},{personId:{eq:${JSON.stringify(member)}}}]}`);
      if (!participants.length) {
        const participantId = await stableId('participant:' + id + ':' + member);
        if (!await this.byId('socialConnectionParticipants',participantId)) {
          await this.create('socialConnectionParticipant','SocialConnectionParticipantCreateInput',{id:participantId,socialConnectionId:id,personId:member});
          if (!await this.byId('socialConnectionParticipants',participantId)) throw new Error('Relationship participant could not be read back.');
        }
      }
    }
    return id;
  }
}
