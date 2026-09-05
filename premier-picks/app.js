(() => {
  const cfg = window.PREMIER_PICKS || window.PREMIER_PICKS_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes("YOUR_PROJECT") &&
    cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_KEY");

  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY) : null;

  let user=null, profile=null, currentMw=1, fixtures=[], predictions=new Map(), confirmation=null;
  const $=id=>document.getElementById(id);

  const els={
    fixtures:$("fixtures"),matchweek:$("matchweekSelect"),mwTitle:$("mwTitle"),
    prev:$("prevMw"),next:$("nextMw"),confirm:$("confirmBtn"),
    confirmTitle:$("confirmTitle"),confirmText:$("confirmText"),banner:$("statusBanner"),
    signIn:$("signInBtn"),signOut:$("signOutBtn"),accountName:$("accountName"),
    auth:$("authModal"),email:$("emailInput"),send:$("sendMagicLink"),
    authMessage:$("authMessage"),toast:$("toast"),leaderboard:$("leaderboardRows")
  };

  for(let i=1;i<=38;i++){const o=document.createElement("option");o.value=i;o.textContent=`Matchweek ${i}`;els.matchweek.appendChild(o);}

  document.querySelectorAll(".nav-btn").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
  $("closeAuth")?.addEventListener("click",()=>els.auth.classList.add("hidden"));
  els.signIn?.addEventListener("click",()=>els.auth.classList.remove("hidden"));
  els.signOut?.addEventListener("click",async()=>{if(sb)await sb.auth.signOut();});
  els.matchweek?.addEventListener("change",()=>{currentMw=Number(els.matchweek.value);loadWeek();});
  els.prev?.addEventListener("click",()=>{if(currentMw>1){currentMw--;els.matchweek.value=currentMw;loadWeek();}});
  els.next?.addEventListener("click",()=>{if(currentMw<38){currentMw++;els.matchweek.value=currentMw;loadWeek();}});
  els.confirm?.addEventListener("click",confirmWeek);
  $("refreshLeaderboard")?.addEventListener("click",loadLeaderboard);
  els.send?.addEventListener("click",sendMagicLink);

  function switchView(view){
    document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
    ["predict","leaderboard","rules"].forEach(name=>$(`${name}View`)?.classList.toggle("hidden",name!==view));
    $("hero")?.classList.toggle("hidden",view!=="predict");
    if(view==="leaderboard")loadLeaderboard();
  }

  function toast(msg){if(!els.toast)return;els.toast.textContent=msg;els.toast.classList.remove("hidden");setTimeout(()=>els.toast.classList.add("hidden"),2600);}
  function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  function liveStatus(s){return ["LIVE","IN_PLAY","PAUSED"].includes(s);}
  function pointsFor(p,f){
    if(p?.home_pred==null||p?.away_pred==null||f.home_score==null||f.away_score==null)return null;
    const ph=Number(p.home_pred),pa=Number(p.away_pred),ah=Number(f.home_score),aa=Number(f.away_score);
    if(ph===ah&&pa===aa)return 4;
    return Math.sign(ph-pa)===Math.sign(ah-aa)?3:0;
  }

  function formHtml(arr){
    if(!Array.isArray(arr)||!arr.length)return `<span style="font-size:10px;color:#66718b">—</span>`;
    return arr.map(x=>{
      const bg=x==="W"?"#2f7d4a":x==="D"?"#81722b":"#7a3340";
      return `<span style="display:inline-flex;width:20px;height:20px;border-radius:50%;align-items:center;justify-content:center;background:${bg};color:#fff;font-size:9px;font-weight:800;margin:2px">${x}</span>`;
    }).join("");
  }

  async function sendMagicLink(){
    if(!sb){els.authMessage.textContent="Configure Supabase first.";return;}
    const email=els.email.value.trim();
    if(!email){els.authMessage.textContent="Enter your email.";return;}
    els.send.disabled=true;
    const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:"https://robineappen.github.io/premier-picks/"}});
    els.send.disabled=false;
    els.authMessage.textContent=error?error.message:"Check your email for the sign-in link.";
  }

  async function ensureProfile(){
    if(!user)return;
    const q=await sb.from("profiles").select("id,display_name").eq("id",user.id).maybeSingle();
    if(q.data){profile=q.data;return;}
    const suggested=(user.email||"Player").split("@")[0].slice(0,24);
    const name=prompt("Choose your leaderboard name:",suggested);
    if(!name)return;
    const created=await sb.from("profiles").insert({id:user.id,display_name:name.trim().slice(0,24)}).select().single();
    if(created.error){toast(created.error.message);return;}
    profile=created.data;
  }

  async function chooseCurrentMatchweek(){
    const {data,error}=await sb.from("fixtures").select("matchweek,kickoff,status").order("matchweek").order("kickoff");
    if(error||!data?.length)return;

    const live=data.find(x=>liveStatus(x.status));
    if(live){currentMw=Number(live.matchweek);els.matchweek.value=currentMw;return;}

    const now=Date.now(),groups=new Map();
    data.forEach(x=>{const mw=Number(x.matchweek);if(!groups.has(mw))groups.set(mw,[]);groups.get(mw).push(x);});

    let chosen=null;
    for(const [mw,list] of groups){
      const unfinished=list.some(x=>x.status!=="FINISHED");
      const relevant=list.some(x=>new Date(x.kickoff).getTime()>=now-36*3600*1000);
      if(unfinished&&relevant){chosen=mw;break;}
    }
    if(chosen==null)chosen=Math.max(...data.map(x=>Number(x.matchweek)||1));
    currentMw=chosen;els.matchweek.value=currentMw;
  }

  async function refreshAuth(){
    if(!sb)return;
    const {data:{session}}=await sb.auth.getSession();
    user=session?.user||null;profile=null;

    els.signIn?.classList.toggle("hidden",!!user);
    els.signOut?.classList.toggle("hidden",!user);
    els.accountName?.classList.toggle("hidden",!user);

    if(!user){
      if(els.fixtures)els.fixtures.innerHTML=`<div class="empty-card">Sign in to make predictions.</div>`;
      return;
    }

    await ensureProfile();
    if(els.accountName)els.accountName.textContent=profile?.display_name||user.email||"";
    els.auth?.classList.add("hidden");
    await chooseCurrentMatchweek();
    await loadWeek();
  }

  async function loadWeek(){
    if(!sb||!user)return;
    els.mwTitle.textContent=`Matchweek ${currentMw}`;
    els.fixtures.innerHTML=`<div class="empty-card">Loading Matchweek ${currentMw}…</div>`;

    const [fx,pr,cf]=await Promise.all([
      sb.from("fixtures").select("*").eq("matchweek",currentMw).order("kickoff"),
      sb.from("predictions").select("fixture_id,home_pred,away_pred").eq("user_id",user.id),
      sb.from("confirmations").select("*").eq("user_id",user.id).eq("matchweek",currentMw).maybeSingle()
    ]);

    if(fx.error){els.fixtures.innerHTML=`<div class="empty-card">${esc(fx.error.message)}</div>`;return;}

    fixtures=fx.data||[];
    predictions=new Map((pr.data||[]).map(p=>[String(p.fixture_id),p]));
    confirmation=cf.data||null;
    renderFixtures();
    updateConfirmBar();
  }

  function renderFixtures(){
    if(!fixtures.length){els.fixtures.innerHTML=`<div class="empty-card">No fixtures for Matchweek ${currentMw}.</div>`;return;}

    els.fixtures.innerHTML=fixtures.map(f=>{
      const p=predictions.get(String(f.id))||{};
      const live=liveStatus(f.status)&&f.home_score!=null&&f.away_score!=null;
      const finished=f.status==="FINISHED"&&f.home_score!=null&&f.away_score!=null;
      const started=Date.now()>=new Date(f.kickoff).getTime()||live||finished;
      const locked=!!confirmation||started;
      const pts=(live||finished)?pointsFor(p,f):null;

      const dt=new Date(f.kickoff);
      const date=dt.toLocaleString([],{weekday:"short",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

      let center=`<div class="versus">VS</div>`;
      if(live||finished){
        let state=finished?"FT":"LIVE";
        if(!finished&&f.status==="PAUSED")state="HT";
        else if(!finished&&f.minute!=null)state=`LIVE ${f.minute}'`;

        center=`<div style="text-align:center">
          <div style="font-size:25px;font-weight:900;color:${finished?"#b8ff43":"#ff6f82"}">${f.home_score}–${f.away_score}</div>
          <div style="font-size:9px;letter-spacing:.12em;margin-top:5px;color:${finished?"#8f9ab5":"#ff6f82"}">${state}</div>
        </div>`;
      }

      return `<article class="fixture-card" data-fixture="${f.id}">
        <div class="fixture-meta"><span>${esc(date)}${f.venue?` · ${esc(f.venue)}`:""}</span><span>${esc(f.status||"SCHEDULED")}</span></div>
        <div class="teams">
          <div class="team">${esc(f.home_team)}<div style="font-size:9px;color:#8f9ab5;margin-top:3px">HOME</div><div style="margin-top:7px">${formHtml(f.home_form)}</div></div>
          ${center}
          <div class="team away">${esc(f.away_team)}<div style="font-size:9px;color:#8f9ab5;margin-top:3px">AWAY</div><div style="margin-top:7px">${formHtml(f.away_form)}</div></div>
        </div>

        <div class="prediction-inputs">
          <input type="number" inputmode="numeric" min="0" max="20" data-side="home" value="${p.home_pred??""}" ${locked?"disabled":""}>
          <div class="dash">—</div>
          <input type="number" inputmode="numeric" min="0" max="20" data-side="away" value="${p.away_pred??""}" ${locked?"disabled":""}>
        </div>

        <div class="actual">
          ${p.home_pred!=null&&p.away_pred!=null?`Your pick: <strong>${p.home_pred}–${p.away_pred}</strong>`:"No prediction saved"}
          ${(live||finished)&&pts!=null?` · <strong>${live?"Provisional ":""}+${pts} pts</strong>`:""}
        </div>

        ${started?`
          <button type="button" class="ghost-btn match-picks-btn" style="margin-top:12px;width:100%">
            ${finished?"View everyone's final picks":"View live match picks"}
          </button>
          <div class="match-picks-panel hidden" style="margin-top:12px"></div>
        `:""}
      </article>`;
    }).join("");

    els.fixtures.querySelectorAll(".fixture-card").forEach(card=>{
      const f=fixtures.find(x=>String(x.id)===String(card.dataset.fixture));
      card.querySelectorAll(".prediction-inputs input").forEach(i=>i.addEventListener("change",()=>savePrediction(card,f)));
      card.querySelector(".match-picks-btn")?.addEventListener("click",()=>toggleMatchPredictions(card,f));
    });
  }

  async function savePrediction(card,f){
    if(!sb||!user||confirmation)return;
    if(Date.now()>=new Date(f.kickoff).getTime()){toast("This match has already kicked off.");await loadWeek();return;}

    const inputs=[...card.querySelectorAll(".prediction-inputs input")];
    const h=inputs[0].value,a=inputs[1].value;
    if(h===""||a==="")return;

    const payload={user_id:user.id,fixture_id:Number(f.id),home_pred:Number(h),away_pred:Number(a),updated_at:new Date().toISOString()};
    const {error}=await sb.from("predictions").upsert(payload,{onConflict:"user_id,fixture_id"});
    if(error){toast(error.message);return;}

    predictions.set(String(f.id),payload);
    toast("Prediction saved ✓");
    updateConfirmBar();
  }

  async function toggleMatchPredictions(card,f){
    const panel=card.querySelector(".match-picks-panel");
    if(!panel)return;

    if(!panel.classList.contains("hidden")){panel.classList.add("hidden");return;}

    panel.classList.remove("hidden");
    panel.innerHTML=`<div class="actual">Loading everyone's picks…</div>`;

    const {data,error}=await sb.rpc("get_match_predictions",{p_fixture_id:Number(f.id)});
    if(error){panel.innerHTML=`<div class="actual">${esc(error.message)}</div>`;return;}
    if(!data?.length){panel.innerHTML=`<div class="actual">No predictions were saved for this match.</div>`;return;}

    const maxPts=Math.max(...data.map(x=>x.current_points??-1));
    const hasScore=f.home_score!=null&&f.away_score!=null;

    panel.innerHTML=`<div style="border-top:1px solid rgba(255,255,255,.08);padding-top:12px">
      <div style="font-size:10px;letter-spacing:.12em;color:#8f9ab5;margin-bottom:8px">${f.status==="FINISHED"?"FINAL MATCH PICKS":"LIVE MATCH PICKS"}</div>
      ${data.map(row=>{
        const leader=hasScore&&row.current_points===maxPts;
        return `<div style="display:grid;grid-template-columns:minmax(100px,1fr) 70px 90px;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.055)">
          <strong style="${leader?"color:#b8ff43":""}">${esc(row.display_name)}${leader?" ★":""}</strong>
          <span style="text-align:center;font-weight:800">${row.home_pred}–${row.away_pred}</span>
          <span style="text-align:right;color:${leader?"#b8ff43":"#c8cede"}">${row.current_points==null?"—":`${f.status==="FINISHED"?"":"~ "}${row.current_points} pts`}</span>
        </div>`;
      }).join("")}
    </div>`;
  }

  function updateConfirmBar(){
    const complete=fixtures.length>0&&fixtures.every(f=>{
      if(Date.now()>=new Date(f.kickoff).getTime())return true;
      const p=predictions.get(String(f.id));
      return p&&p.home_pred!=null&&p.away_pred!=null;
    });

    if(confirmation){
      els.confirm.disabled=true;els.confirm.textContent="Locked ✓";
      els.confirmTitle.textContent=`Matchweek ${currentMw} confirmed`;
      els.confirmText.textContent="Your remaining predictions are locked.";
      els.banner.textContent="✓ Predictions confirmed and locked.";
      els.banner.classList.remove("hidden");
    }else{
      els.confirm.disabled=!complete;els.confirm.textContent="Confirm predictions";
      els.confirmTitle.textContent=complete?"Ready to lock":"Predictions open";
      els.confirmText.textContent="Individual matches lock automatically at kickoff.";
      els.banner.classList.add("hidden");
    }
  }

  async function confirmWeek(){
    if(!confirm(`Lock all remaining Matchweek ${currentMw} predictions?`))return;
    const {error}=await sb.rpc("confirm_matchweek",{p_matchweek:currentMw});
    if(error){toast(error.message);return;}
    toast(`Matchweek ${currentMw} locked ✓`);
    await loadWeek();
  }

  async function loadLeaderboard(){
    if(!sb||!els.leaderboard)return;
    els.leaderboard.innerHTML=`<div class="empty-card borderless">Loading…</div>`;
    const {data,error}=await sb.rpc("get_leaderboard");
    if(error){els.leaderboard.innerHTML=`<div class="empty-card borderless">${esc(error.message)}</div>`;return;}

    els.leaderboard.innerHTML=(data||[]).map((r,i)=>`
      <div class="leader-row ${i<3?"top":""}">
        <span class="rank">${r.rank}</span>
        <span class="player-cell">${esc(r.display_name)}<small>${r.matches_scored} scored ${r.matches_scored===1?"match":"matches"}</small></span>
        <span class="points">${r.total_points}</span><span>${r.exact_scores}</span><span>${r.correct_outcomes}</span>
      </div>`).join("")||`<div class="empty-card borderless">No scored matches yet.</div>`;
  }

  if(sb)sb.auth.onAuthStateChange(()=>setTimeout(refreshAuth,0));
  refreshAuth();

  setInterval(async()=>{
    if(!user)return;
    await loadWeek();
    if(!$("leaderboardView")?.classList.contains("hidden"))await loadLeaderboard();
  },60000);
})();
