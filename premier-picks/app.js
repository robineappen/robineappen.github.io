(() => {
  const cfg = window.PREMIER_PICKS || window.PREMIER_PICKS_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes("YOUR_PROJECT") &&
    cfg.SUPABASE_PUBLISHABLE_KEY &&
    !cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_KEY");

  const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY) : null;

  let user=null, profile=null, currentMw=1, fixtures=[], predictions=new Map(), confirmation=null;
  let bonanzaDismissedThisPage=false;
  let mw10DismissedThisPage=false;
  let allInPick=null;
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
    const exact=ph===ah&&pa===aa;
    const correctOutcome=Math.sign(ph-pa)===Math.sign(ah-aa);
    const isAllIn=Number(f.matchweek)===10 && Number(allInPick?.fixture_id)===Number(f.id);

    if(isAllIn){
      if(exact)return 38;
      if(correctOutcome)return 30;
      return -50;
    }

    if(exact)return 4;
    return correctOutcome?3:0;
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


  // ----------------------------------------------------------
  // MATCHWEEK 5 BONANZA / WINNER ANNOUNCEMENT
  // Before MW5 finishes: show the Bonanza promotion.
  // After MW5 finishes: show the winner(s) for about two weeks.
  // Both overlays require X to continue.
  // ----------------------------------------------------------
  function removeBonanzaModal(){
    document.getElementById("bonanzaOverlay")?.remove();
    document.body.style.overflow="";
  }

  function showBonanzaOverlay({winnerMode=false,winners=[],mw5Points=null}={}){
    if(bonanzaDismissedThisPage || document.getElementById("bonanzaOverlay")) return;

    const names=winners.map(x=>x.display_name).filter(Boolean);
    const winnerText =
      names.length===1
        ? esc(names[0])
        : names.length===2
          ? `${esc(names[0])} & ${esc(names[1])}`
          : names.length>2
            ? `${names.slice(0,-1).map(esc).join(", ")} & ${esc(names[names.length-1])}`
            : "Our Bonanza winner";

    const overlay=document.createElement("div");
    overlay.id="bonanzaOverlay";
    overlay.setAttribute("role","dialog");
    overlay.setAttribute("aria-modal","true");
    overlay.setAttribute("aria-labelledby","bonanzaTitle");

    overlay.innerHTML=`
      <style>
        #bonanzaOverlay{
          position:fixed;inset:0;z-index:99999;display:flex;align-items:center;
          justify-content:center;padding:22px;background:rgba(3,8,19,.91);
          backdrop-filter:blur(10px)
        }
        #bonanzaOverlay .bonanza-box{
          position:relative;width:min(760px,100%);border:1px solid rgba(184,255,67,.35);
          border-radius:24px;padding:54px 34px 38px;text-align:center;
          background:radial-gradient(circle at 50% 0%,rgba(184,255,67,.14),transparent 48%),#0b1324;
          box-shadow:0 24px 80px rgba(0,0,0,.55);color:#eef3ff
        }
        #bonanzaOverlay .bonanza-close{
          position:absolute;top:15px;right:16px;width:44px;height:44px;border-radius:50%;
          border:1px solid rgba(255,255,255,.17);background:rgba(255,255,255,.07);
          color:#fff;font-size:27px;line-height:1;cursor:pointer
        }
        #bonanzaOverlay .bonanza-kicker{
          display:inline-block;margin-bottom:14px;padding:7px 13px;border-radius:999px;
          background:rgba(184,255,67,.12);color:#b8ff43;font-size:12px;font-weight:900;
          letter-spacing:.16em
        }
        #bonanzaOverlay h2{
          margin:0;font-size:clamp(34px,7vw,66px);line-height:.98;letter-spacing:-.04em
        }
        #bonanzaOverlay .bonanza-name{
          margin:22px auto 8px;color:#b8ff43;font-size:clamp(34px,8vw,68px);
          line-height:1;font-weight:950;overflow-wrap:anywhere
        }
        #bonanzaOverlay .bonanza-points{
          margin:20px 0 10px;color:#b8ff43;font-size:clamp(46px,10vw,86px);
          line-height:1;font-weight:950
        }
        #bonanzaOverlay .bonanza-copy{
          max-width:590px;margin:0 auto;color:#b9c3d8;font-size:17px;line-height:1.55
        }
        #bonanzaOverlay .bonanza-copy strong{color:#fff}
        #bonanzaOverlay .bonanza-note{margin-top:20px;color:#7f8aa4;font-size:12px}
      </style>

      <div class="bonanza-box">
        <button class="bonanza-close" type="button" aria-label="Close announcement">×</button>

        ${
          winnerMode
            ? `
              <div class="bonanza-kicker">BONANZA WEEK 5 CHAMPION${names.length>1?"S":""}</div>
              <h2 id="bonanzaTitle">🏆 CONGRATULATIONS!</h2>
              <div class="bonanza-name">${winnerText}</div>
              <p class="bonanza-copy">
                ${names.length>1?"You finished joint top":"You finished top"} of Matchweek 5
                ${mw5Points!=null?`with <strong>${mw5Points} normal points</strong>`:""}
                and earned the <strong>+10 Bonanza bonus</strong> on the overall leaderboard.
              </p>
              <div class="bonanza-note">Matchweek 5 Bonanza complete 🎉</div>
            `
            : `
              <div class="bonanza-kicker">SPECIAL ROUND</div>
              <h2 id="bonanzaTitle">🎉 MATCHWEEK 5<br>BONANZA</h2>
              <div class="bonanza-points">+10 PTS</div>
              <p class="bonanza-copy">
                Finish <strong>top of Matchweek 5</strong> and earn an extra
                <strong>10 bonus points</strong> on the overall leaderboard.
                If players tie for the highest Matchweek 5 score, every tied winner gets the bonus.
              </p>
              <div class="bonanza-note">
                The bonus is awarded only after every Matchweek 5 fixture is finished.
              </div>
            `
        }
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow="hidden";

    const close=overlay.querySelector(".bonanza-close");
    close.addEventListener("click",()=>{
      bonanzaDismissedThisPage=true;
      removeBonanzaModal();
    });
    setTimeout(()=>close.focus(),0);
  }

  async function refreshBonanzaState(){
    if(!sb || !user) return;

    const {data:fixtures5,error:fixtureError}=await sb
      .from("fixtures")
      .select("id,status")
      .eq("matchweek",5);

    if(fixtureError || !fixtures5?.length) return;

    const finished=fixtures5.every(f=>f.status==="FINISHED");

    if(!finished){
      showBonanzaOverlay({winnerMode:false});
      return;
    }

    // Once MW5 is complete, use the secure database function to get
    // the winner(s), weekly score, and the date until which to display.
    const {data,error}=await sb.rpc("get_mw5_bonanza_winners");
    if(error || !data?.length){
      removeBonanzaModal();
      return;
    }

    const displayUntil=new Date(data[0].display_until);
    if(Date.now() > displayUntil.getTime()){
      removeBonanzaModal();
      return;
    }

    const points=data[0].mw5_points;
    showBonanzaOverlay({
      winnerMode:true,
      winners:data,
      mw5Points:points
    });
  }


  // ----------------------------------------------------------
  // MATCHWEEK 10 — HIGH JEOPARDY ALL-IN
  // Before/during MW10: large rules notice on every page visit.
  // After MW10: results notice for ~14 days with winner(s) and
  // every player's All-In gain/loss.
  // ----------------------------------------------------------
  function removeMW10Modal(){
    document.getElementById("mw10Overlay")?.remove();
    if(!document.getElementById("bonanzaOverlay")) document.body.style.overflow="";
  }

  function showMW10RulesModal(){
    if(mw10DismissedThisPage || document.getElementById("mw10Overlay")) return;

    const overlay=document.createElement("div");
    overlay.id="mw10Overlay";
    overlay.setAttribute("role","dialog");
    overlay.setAttribute("aria-modal","true");
    overlay.setAttribute("aria-labelledby","mw10Title");

    overlay.innerHTML=`
      <style>
        #mw10Overlay{
          position:fixed;inset:0;z-index:100000;display:flex;align-items:center;
          justify-content:center;padding:22px;background:rgba(3,7,16,.93);
          backdrop-filter:blur(11px)
        }
        #mw10Overlay .mw10-box{
          position:relative;width:min(790px,100%);max-height:92vh;overflow:auto;
          border:1px solid rgba(255,190,51,.42);border-radius:26px;padding:54px 34px 38px;
          text-align:center;color:#eef3ff;
          background:
            radial-gradient(circle at 50% 0%,rgba(255,177,40,.14),transparent 44%),
            radial-gradient(circle at 100% 60%,rgba(255,65,75,.08),transparent 35%),
            #0a1222;
          box-shadow:0 28px 90px rgba(0,0,0,.58)
        }
        #mw10Overlay .mw10-close{
          position:absolute;top:15px;right:16px;width:44px;height:44px;border-radius:50%;
          border:1px solid rgba(255,255,255,.17);background:rgba(255,255,255,.07);
          color:#fff;font-size:27px;line-height:1;cursor:pointer
        }
        #mw10Overlay .mw10-kicker{
          display:inline-block;padding:7px 14px;border-radius:999px;
          background:rgba(255,184,45,.12);color:#ffc14f;font-size:12px;
          font-weight:900;letter-spacing:.16em;margin-bottom:14px
        }
        #mw10Overlay h2{
          margin:0;font-size:clamp(36px,7vw,66px);line-height:.98;letter-spacing:-.045em
        }
        #mw10Overlay .mw10-sub{
          margin:16px auto 24px;max-width:590px;color:#b9c3d8;font-size:17px;line-height:1.5
        }
        #mw10Overlay .mw10-rulegrid{
          display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0
        }
        #mw10Overlay .mw10-score{
          padding:18px 10px;border-radius:16px;border:1px solid rgba(255,255,255,.10);
          background:rgba(255,255,255,.045)
        }
        #mw10Overlay .mw10-score strong{display:block;font-size:34px;line-height:1.05}
        #mw10Overlay .mw10-exact strong,#mw10Overlay .mw10-correct strong{color:#b8ff43}
        #mw10Overlay .mw10-wrong strong{color:#ff5d68}
        #mw10Overlay .mw10-normal{
          margin:18px auto 0;max-width:620px;padding:13px 16px;border-radius:14px;
          background:rgba(184,255,67,.07);border:1px solid rgba(184,255,67,.18);
          color:#d9e5ee;font-size:14px
        }
        #mw10Overlay .mw10-danger{margin-top:18px;color:#ff9a9f;font-weight:800}
        #mw10Overlay .mw10-results{
          margin-top:22px;text-align:left;border-top:1px solid rgba(255,255,255,.09)
        }
        #mw10Overlay .mw10-result-row{
          display:grid;grid-template-columns:minmax(95px,1fr) minmax(150px,1.5fr) 72px 82px;
          gap:10px;align-items:center;padding:10px 4px;
          border-bottom:1px solid rgba(255,255,255,.065);font-size:13px
        }
        #mw10Overlay .winner-row{background:rgba(184,255,67,.055)}
        #mw10Overlay .gain{color:#b8ff43;font-weight:900}
        #mw10Overlay .loss{color:#ff6873;font-weight:900}
        @media(max-width:620px){
          #mw10Overlay .mw10-rulegrid{grid-template-columns:1fr}
          #mw10Overlay .mw10-result-row{
            grid-template-columns:1fr 70px;
          }
          #mw10Overlay .mw10-result-row .match-cell{
            grid-column:1 / -1;color:#98a5bd;font-size:12px
          }
        }
      </style>

      <div class="mw10-box">
        <button class="mw10-close" type="button" aria-label="Close Matchweek 10 announcement">×</button>
        <div class="mw10-kicker">PREMIER PICKS · MATCHWEEK 10 SPECIAL</div>
        <h2 id="mw10Title">🔥 HIGH JEOPARDY<br>ALL-IN 🔥</h2>
        <p class="mw10-sub">
          Choose <strong>ONE Matchweek 10 fixture</strong> to go All-In on.
          You choose the match. Every other MW10 fixture keeps the normal scoring.
        </p>

        <div class="mw10-rulegrid">
          <div class="mw10-score mw10-exact"><strong>+38</strong>🎯 Exact score</div>
          <div class="mw10-score mw10-correct"><strong>+30</strong>✅ Correct outcome</div>
          <div class="mw10-score mw10-wrong"><strong>−50</strong>💀 Wrong outcome</div>
        </div>

        <div class="mw10-normal">
          All other Matchweek 10 matches remain normal:
          <strong>Exact +4 · Correct outcome +3 · Wrong 0</strong>
        </div>
        <div class="mw10-danger">One choice. Huge reward. Huge jeopardy. 😈</div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow="hidden";
    const close=overlay.querySelector(".mw10-close");
    close.addEventListener("click",()=>{
      mw10DismissedThisPage=true;
      removeMW10Modal();
    });
    setTimeout(()=>close.focus(),0);
  }

  function showMW10ResultsModal(rows){
    if(mw10DismissedThisPage || document.getElementById("mw10Overlay") || !rows?.length) return;

    const winners=rows.filter(r=>Number(r.mw10_rank)===1);
    const names=winners.map(r=>r.display_name);
    const winnerText=names.length===1
      ? esc(names[0])
      : names.length===2
        ? `${esc(names[0])} & ${esc(names[1])}`
        : `${names.slice(0,-1).map(esc).join(", ")} & ${esc(names[names.length-1])}`;

    const overlay=document.createElement("div");
    overlay.id="mw10Overlay";
    overlay.setAttribute("role","dialog");
    overlay.setAttribute("aria-modal","true");
    overlay.setAttribute("aria-labelledby","mw10Title");

    overlay.innerHTML=`
      <style>
        #mw10Overlay{
          position:fixed;inset:0;z-index:100000;display:flex;align-items:center;
          justify-content:center;padding:18px;background:rgba(3,7,16,.94);
          backdrop-filter:blur(11px)
        }
        #mw10Overlay .mw10-box{
          position:relative;width:min(900px,100%);max-height:92vh;overflow:auto;
          border:1px solid rgba(184,255,67,.34);border-radius:26px;padding:52px 28px 30px;
          text-align:center;color:#eef3ff;
          background:radial-gradient(circle at 50% 0%,rgba(184,255,67,.13),transparent 42%),#0a1222;
          box-shadow:0 28px 90px rgba(0,0,0,.58)
        }
        #mw10Overlay .mw10-close{
          position:absolute;top:14px;right:15px;width:44px;height:44px;border-radius:50%;
          border:1px solid rgba(255,255,255,.17);background:rgba(255,255,255,.07);
          color:#fff;font-size:27px;line-height:1;cursor:pointer
        }
        #mw10Overlay .mw10-kicker{
          display:inline-block;padding:7px 14px;border-radius:999px;
          background:rgba(184,255,67,.1);color:#b8ff43;font-size:12px;
          font-weight:900;letter-spacing:.16em;margin-bottom:14px
        }
        #mw10Overlay h2{margin:0;font-size:clamp(34px,7vw,64px);line-height:1;letter-spacing:-.04em}
        #mw10Overlay .champion{margin:18px 0 7px;color:#b8ff43;font-size:clamp(30px,7vw,58px);font-weight:950}
        #mw10Overlay .summary{color:#b9c3d8;margin:0 auto 20px;max-width:650px;line-height:1.5}
        #mw10Overlay .mw10-results{margin-top:20px;text-align:left;border-top:1px solid rgba(255,255,255,.09)}
        #mw10Overlay .mw10-result-row{
          display:grid;grid-template-columns:minmax(100px,1fr) minmax(180px,1.7fr) 78px 88px 82px;
          gap:10px;align-items:center;padding:11px 5px;border-bottom:1px solid rgba(255,255,255,.065);
          font-size:13px
        }
        #mw10Overlay .header-row{color:#7f8aa4;font-size:10px;letter-spacing:.09em;text-transform:uppercase}
        #mw10Overlay .winner-row{background:rgba(184,255,67,.055)}
        #mw10Overlay .gain{color:#b8ff43;font-weight:900}
        #mw10Overlay .loss{color:#ff6873;font-weight:900}
        #mw10Overlay .neutral{color:#aab4c8;font-weight:800}
        @media(max-width:720px){
          #mw10Overlay .header-row{display:none}
          #mw10Overlay .mw10-result-row{
            grid-template-columns:minmax(100px,1fr) 72px 78px;
          }
          #mw10Overlay .match-cell{grid-column:1/-1;color:#96a2b8;font-size:12px}
          #mw10Overlay .weekly-total{display:none}
        }
      </style>

      <div class="mw10-box">
        <button class="mw10-close" type="button" aria-label="Close Matchweek 10 results">×</button>
        <div class="mw10-kicker">MATCHWEEK 10 · HIGH JEOPARDY COMPLETE</div>
        <h2 id="mw10Title">🏆 ALL-IN RESULTS</h2>
        <div class="champion">${winnerText}</div>
        <p class="summary">
          ${winners.length===1?"takes":"take"} the Matchweek 10 crown with
          <strong>${Number(winners[0].mw10_total)} net MW10 points</strong>.
          Here’s how everyone’s All-In gamble landed:
        </p>

        <div class="mw10-results">
          <div class="mw10-result-row header-row">
            <span>Player</span><span>All-In match</span><span>Pick</span><span>All-In</span><span>MW10</span>
          </div>
          ${rows.map(r=>{
            const pts=r.all_in_points;
            const cls=pts>0?"gain":pts<0?"loss":"neutral";
            const ptsText=pts==null?"No All-In":`${pts>0?"+":""}${pts}`;
            const match=r.all_in_fixture_id
              ? `${esc(r.home_team)} vs ${esc(r.away_team)}`
              : "No All-In selected";
            const pick=r.all_in_fixture_id ? `${r.home_pred}–${r.away_pred}` : "—";
            const result=r.all_in_fixture_id ? `${r.home_score}–${r.away_score}` : "";
            return `
              <div class="mw10-result-row ${Number(r.mw10_rank)===1?"winner-row":""}">
                <strong>${Number(r.mw10_rank)===1?"👑 ":""}${esc(r.display_name)}</strong>
                <span class="match-cell">${match}${result?` · FT ${result}`:""}</span>
                <span>${pick}</span>
                <span class="${cls}">${ptsText}</span>
                <span class="weekly-total"><strong>${Number(r.mw10_total)}</strong></span>
              </div>`;
          }).join("")}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow="hidden";
    const close=overlay.querySelector(".mw10-close");
    close.addEventListener("click",()=>{
      mw10DismissedThisPage=true;
      removeMW10Modal();
    });
    setTimeout(()=>close.focus(),0);
  }

  async function refreshMW10State(){
    if(!sb || !user) return;

    const {data:fx,error}=await sb
      .from("fixtures")
      .select("id,status")
      .eq("matchweek",10);

    if(error || !fx?.length) return;

    const finished=fx.every(f=>f.status==="FINISHED");

    if(!finished){
      showMW10RulesModal();
      return;
    }

    const {data:rows,error:resultError}=await sb.rpc("get_mw10_all_in_results");
    if(resultError || !rows?.length){
      removeMW10Modal();
      return;
    }

    const displayUntil=new Date(rows[0].display_until);
    if(Date.now()>displayUntil.getTime()){
      removeMW10Modal();
      return;
    }

    showMW10ResultsModal(rows);
  }

  async function chooseAllIn(fixtureId){
    if(!sb||!user)return;

    const fixture=fixtures.find(f=>Number(f.id)===Number(fixtureId));
    if(!fixture)return;

    const existing=allInPick?.fixture_id
      ? fixtures.find(f=>Number(f.id)===Number(allInPick.fixture_id))
      : null;

    const message=existing && Number(existing.id)!==Number(fixture.id)
      ? `Change your All-In from ${existing.home_team} vs ${existing.away_team} to ${fixture.home_team} vs ${fixture.away_team}?`
      : `Go ALL-IN on ${fixture.home_team} vs ${fixture.away_team}?\\n\\nExact +38 · Correct outcome +30 · Wrong −50`;

    if(!confirm(message))return;

    const {data,error}=await sb.rpc("set_mw10_all_in",{p_fixture_id:Number(fixtureId)});
    if(error){toast(error.message);return;}

    allInPick={fixture_id:Number(fixtureId),selected_at:data?.selected_at||new Date().toISOString()};
    toast("🔥 All-In match selected");
    renderFixtures();
    updateConfirmBar();
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
    await refreshBonanzaState();
    await refreshMW10State();
    await loadWeek();
  }

  async function loadWeek(){
    if(!sb||!user)return;
    els.mwTitle.textContent=`Matchweek ${currentMw}`;
    els.fixtures.innerHTML=`<div class="empty-card">Loading Matchweek ${currentMw}…</div>`;

    const [fx,pr,cf,ai]=await Promise.all([
      sb.from("fixtures").select("*").eq("matchweek",currentMw).order("kickoff"),
      sb.from("predictions").select("fixture_id,home_pred,away_pred").eq("user_id",user.id),
      sb.from("confirmations").select("*").eq("user_id",user.id).eq("matchweek",currentMw).maybeSingle(),
      sb.from("mw10_all_in_picks").select("fixture_id,selected_at").eq("user_id",user.id).maybeSingle()
    ]);

    if(fx.error){els.fixtures.innerHTML=`<div class="empty-card">${esc(fx.error.message)}</div>`;return;}

    fixtures=fx.data||[];
    predictions=new Map((pr.data||[]).map(p=>[String(p.fixture_id),p]));
    confirmation=cf.data||null;
    allInPick=ai.data||null;
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
      const isAllIn=Number(currentMw)===10 && Number(allInPick?.fixture_id)===Number(f.id);

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

      return `<article class="fixture-card" data-fixture="${f.id}" style="${isAllIn?'border:1px solid rgba(255,190,55,.62);box-shadow:0 0 0 1px rgba(255,190,55,.12) inset;':''}">
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
          ${(live||finished)&&pts!=null?` · <strong style="${pts<0?"color:#ff6873":isAllIn?"color:#ffc14f":""}">${live?"Provisional ":""}${pts>0?"+":""}${pts} pts${isAllIn?" · ALL-IN 🔥":""}</strong>`:""}
        </div>

        ${Number(currentMw)===10?`
          <div style="margin-top:12px">
            <button type="button"
              class="ghost-btn all-in-btn"
              data-fixture="${f.id}"
              ${Date.now()>=Math.min(...fixtures.map(x=>new Date(x.kickoff).getTime()))?"disabled":""}
              style="width:100%;${isAllIn?"border-color:#ffc14f;color:#ffc14f;background:rgba(255,193,79,.07)":""}">
              ${isAllIn?"🔥 YOUR ALL-IN MATCH":"🔥 GO ALL-IN ON THIS MATCH"}
            </button>
          </div>
        `:""}

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
      card.querySelector(".all-in-btn")?.addEventListener("click",()=>chooseAllIn(f.id));
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
          <strong style="${leader?"color:#b8ff43":""}">${esc(row.display_name)}${row.is_all_in?" 🔥":""}${leader?" ★":""}</strong>
          <span style="text-align:center;font-weight:800">${row.home_pred}–${row.away_pred}</span>
          <span style="text-align:right;color:${row.current_points<0?"#ff6873":leader?"#b8ff43":"#c8cede"}">${row.current_points==null?"—":`${f.status==="FINISHED"?"":"~ "}${row.current_points>0?"+":""}${row.current_points} pts`}</span>
        </div>`;
      }).join("")}
    </div>`;
  }

  function updateConfirmBar(){
    const normalComplete=fixtures.length>0&&fixtures.every(f=>{
      if(Date.now()>=new Date(f.kickoff).getTime())return true;
      const p=predictions.get(String(f.id));
      return p&&p.home_pred!=null&&p.away_pred!=null;
    });
    const allInReady=Number(currentMw)!==10 || !!allInPick?.fixture_id;
    const complete=normalComplete && allInReady;

    if(confirmation){
      els.confirm.disabled=true;els.confirm.textContent="Locked ✓";
      els.confirmTitle.textContent=`Matchweek ${currentMw} confirmed`;
      els.confirmText.textContent="Your remaining predictions are locked.";
      els.banner.textContent="✓ Predictions confirmed and locked.";
      els.banner.classList.remove("hidden");
    }else{
      els.confirm.disabled=!complete;els.confirm.textContent="Confirm predictions";
      els.confirmTitle.textContent=complete?"Ready to lock":"Predictions open";
      els.confirmText.textContent=Number(currentMw)===10 && !allInReady ? "Complete every prediction and choose your ONE All-In match." : "Individual matches lock automatically at kickoff.";
      els.banner.classList.add("hidden");
    }
  }

  async function confirmWeek(){
    if(Number(currentMw)===10 && !allInPick?.fixture_id){
      toast("Choose your ONE All-In match first 🔥");
      return;
    }
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
    await refreshBonanzaState();
    await refreshMW10State();
    if(!$("leaderboardView")?.classList.contains("hidden"))await loadLeaderboard();
  },60000);
})();
