import sqlite3, collections, datetime, random, shutil, hashlib, re, json
src='/mnt/data/finance.db'; dest='/mnt/data/finance_scrambled.db'
c=sqlite3.connect(src); c.row_factory=sqlite3.Row
rows=c.execute('''select l.*,t.account_id,t.date,t.amount,t.category from option_legs l join transactions t on t.id=l.transaction_id order by t.date,case when l.action in ('STO','BTO') then 0 else 1 end,t.id''').fetchall()
groups=collections.defaultdict(list)
for r in rows:groups[(r['account_id'],r['position_id'],r['expiration_date'],r['strike_price'],r['option_type'])].append(r)
results=collections.defaultdict(lambda:collections.defaultdict(float)); warnings=[]
for key,rr in groups.items():
  shorts=collections.deque(); longs=collections.deque(); realized=0.0; unmatched=0
  for r in rr:
    act=r['action']; q=abs(r['quantity'] or 0); cash=r['amount'];cat=r['category']
    if act in ('STO','BTO'):
      (shorts if act=='STO' else longs).append([q,cash/q if q else 0]);continue
    if act in ('BTC','STC','TRANSFER_OUT','SPLIT') or cat in ('Expired','Assigned'):
      # Expiry and assignment actions may be STC, or coded as BTC with zero amounts; determine side from action and extant inventory.
      if act=='BTC':queue=shorts
      elif act=='STC':queue=longs if longs else shorts
      elif act=='TRANSFER_OUT':queue=shorts if shorts else longs
      elif act=='SPLIT':continue
      else:queue=shorts if shorts else longs
      closable=q; opening_cash=0
      while closable>1e-8 and queue:
        lotq,unit=queue[0]; take=min(lotq,closable); opening_cash+=take*unit;closable-=take;lotq-=take
        if lotq<1e-8:queue.popleft()
        else:queue[0][0]=lotq
      if closable>1e-8: unmatched+=1; warnings.append((key,r['id'],act,closable))
      realized+=opening_cash+cash
  remaining=sum(q*unit for q,unit in shorts)+sum(q*unit for q,unit in longs)
  past_due = key[2] < '2026-10-22' and bool(shorts or longs)
  # 'remaining' is the maximum incremental profit from currently open legs assuming they expire worthless
  account=key[0];results[account]['realized']+=realized;results[account]['open_target']+=0 if past_due else remaining;results[account]['past_due_unresolved']+=remaining if past_due else 0
  results[account]['groups']+=1; results[account]['open_groups']+=bool(shorts or longs)
print('WARNINGS',len(warnings),warnings[:15]);
for a in c.execute('select id,name from accounts'):
 r=results[a['id']];print(a['name'], {k:round(v,2) for k,v in r.items()},'COMBINED',round(r['realized']+r['open_target'],2))
print('TOTAL', {k:sum(v[k] for v in results.values()) for k in ['realized','open_target']})
# anonymization via copy
c.close();shutil.copy2(src,dest);db=sqlite3.connect(dest);db.row_factory=sqlite3.Row
rng=random.Random(181946)
def fac():return rng.uniform(.37,2.72)
def money(x,f):
 if x is None or x==0:return x
 v=round(x*f,2)
 return v if v!=0 else (0.01 if x>0 else -0.01)
with db:
 db.execute('PRAGMA foreign_keys=ON')
 for i,r in enumerate(db.execute('select id from institutions order by id').fetchall(),1):db.execute('update institutions set name=? where id=?',(f'Demo Brokerage {i}',r['id']))
 for i,r in enumerate(db.execute('select id from accounts order by id').fetchall(),1):db.execute('update accounts set name=? where id=?',(f'Demo Account {i}',r['id']))
 db.execute("update users set username='demo_user'")
 for r in db.execute('select key from app_settings').fetchall():
  k=r['key'];v='false' if k=='is_default_db' else hashlib.sha256(('demo-only-'+k).encode()).hexdigest()[:32 if 'salt' in k else 64]
  db.execute('update app_settings set value=? where key=?',(v,k))
 # stable ticker mapping; synthetic labels don't leak actual tickers
 positions=db.execute('select id,underlying_symbol,notes from trade_positions').fetchall()
 syms=sorted({r['underlying_symbol'] for r in positions});symmap={s:'SIM'+str(i+1).zfill(3) for i,s in enumerate(syms)}
 for r in positions:db.execute('update trade_positions set underlying_symbol=?,notes=? where id=?',(symmap[r['underlying_symbol']],None if r['notes'] is None else 'Synthetic test position',r['id']))
 # consistency: quantities & strikes are mapped per entire contract signature, premium proceeds mapped per contract
 details={r['transaction_id']:r for rr in groups.values() for r in rr}
 contract_trans={}
 for key,rr in groups.items():
  ff=fac();strike_scale=fac(); qty_factor=rng.choice([1,2,3]);
  for r in rr:contract_trans[r['transaction_id']]=(ff,strike_scale,qty_factor,key)
 options=set(contract_trans)
 acct_factors={r['id']:fac() for r in db.execute('select id from accounts')}
 txs=db.execute('select * from transactions').fetchall()
 for tx in txs:
  tid=tx['id']; amount=tx['amount']; descr=tx['description'];
  if tid in options:
   ff,ss,qf,key=contract_trans[tid]
   symbol=symmap[db.execute('select underlying_symbol from trade_positions where id=?',(key[1],)).fetchone()[0]] if False else None
   # source symbol via lookup captured before renaming
   p=db.execute('select underlying_symbol from trade_positions where id=?',(key[1],)).fetchone()
   symbol=p[0] if p else 'SIM000'
   r=details[tid]; strike=round(r['strike_price']*ss,2);qty=round(r['quantity']*qf,4)
   newamount=money(amount,ff*qf)
   descr=f'Sym: {symbol} {r["expiration_date"]} {strike:g} {r["option_type"]} | SIMULATED OPTION TRADE | Qty: {qty:g} | Price: {round(abs(newamount)/(100*abs(qty)),2) if qty else 0:.2f} | Fees: {money(r["fees"],ff*qf) or 0:.2f}'
  else:
   newamount=money(amount,acct_factors[tx['account_id']]*rng.uniform(.65,1.4))
   descr=f'Synthetic {tx["category"]} transaction' if descr is not None else None
  db.execute('update transactions set amount=?,description=? where id=?',(newamount,descr,tid))
 for key,rr in groups.items():
  for r in rr:
   ff,ss,qf,_=contract_trans[r['transaction_id']]
   db.execute('update option_legs set strike_price=?,quantity=?,fees=? where id=?',(round(r['strike_price']*ss,2),round(r['quantity']*qf,4),money(r['fees'],ff*qf),r['id']))
 for r in db.execute('select id,amount,description from audit_deletion_log').fetchall():db.execute('update audit_deletion_log set amount=?,description=? where id=?',(money(r['amount'],fac()),'Synthetic deleted transaction' if r['description'] is not None else None,r['id']))
 for r in db.execute('select id,balance from balance_snapshots').fetchall():db.execute('update balance_snapshots set balance=? where id=?',(money(r['balance'],fac()),r['id']))
 for i,r in enumerate(db.execute('select id from imported_files').fetchall(),1):db.execute('update imported_files set file_hash=?,filename=? where id=?',(hashlib.sha256(f'demo-import-{i}'.encode()).hexdigest(),f'demo_import_{i}.csv',r['id']))
print('INTEGRITY',db.execute('pragma integrity_check').fetchone()[0]);print('FKS',db.execute('pragma foreign_key_check').fetchall());db.close()
with open('/mnt/data/finance_pl_summary.json','w') as f:json.dump({str(k):dict(v) for k,v in results.items()},f)
