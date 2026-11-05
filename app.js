(function (global) {
  'use strict';
  const DEFAULT_CONFIG = { WEB_APP_URL:'', STATUS_TIMEOUT_MS:15000, STATUS_POLL_MS:1000, DRAFT_KEY:'pulsa-avaliacao-prefeitura-v2' };
  const config = () => Object.assign({}, DEFAULT_CONFIG, global.PULSA_CONFIG || {});
  const getValue = (source,key) => source && typeof source.get === 'function' ? source.get(key) : source ? source[key] : undefined;
  const text = (source,key) => String(getValue(source,key) ?? '').trim();

  const OPTIONS = {
    q1_prefeitura:['Muito boa','Boa','Regular','Ruim'],
    q2_prefeitura:['Sim','Mais ou menos','Não'],
    q3_prefeitura:['Muito','Sim','Pouco','Não'],
    q4_prefeitura:['Diversão / lazer','Contato com arte e cultura','Conhecimento','Conheci um artista ou trabalho novo','Encontro com outras pessoas','Nenhum destes'],
    q5_prefeitura:['Sim','Talvez','Não'],
    q6_prefeitura:['Frequentemente','Às vezes','Raramente','Esta foi uma das primeiras vezes','Esta foi a primeira vez'],
    q7_prefeitura:['Até 12','13 a 17','18 a 29','30 a 44','45 a 59','60 a 69','70 a 79','80 anos ou mais'],
    q8_prefeitura:['Zona Sul','Zona Leste','Zona Oeste','Zona Norte','Centro','Fora da cidade de São Paulo'],
    q10_prefeitura:['Frequentemente','Às vezes','Raramente','Esta foi uma das primeiras vezes','Esta foi a primeira vez']
  };

  function validateForm(source) {
    const errors = {};
    const reqText = (key,max,msg) => { const v=text(source,key); if(!v) errors[key]=msg||'Este campo é obrigatório.'; else if(v.length>max) errors[key]=`Use no máximo ${max} caracteres.`; return v; };
    const choice = key => { const v=text(source,key); if(!OPTIONS[key].includes(v)) errors[key]='Escolha uma opção.'; return v; };
    reqText('espetaculo',200,'Informe o nome do espetáculo ou atividade.');
    reqText('local',200,'Informe onde a atividade aconteceu.');
    Object.keys(OPTIONS).forEach(choice);
    reqText('bairro_regiao',120,'Informe seu bairro.');
    reqText('q11_prefeitura',250,'Conte como você ficou sabendo deste evento.');
    return {ok:Object.keys(errors).length===0,errors};
  }

  function createSubmissionId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    const r=()=>Math.floor((1+Math.random())*0x10000).toString(16).slice(1);
    return `${r()}${r()}-${r()}-4${r().slice(1)}-8${r().slice(1)}-${r()}${r()}${r()}`;
  }

  function syntheticPhone(submissionId) {
    let hash=2166136261;
    String(submissionId||'').split('').forEach(ch=>{ hash ^= ch.charCodeAt(0); hash = Math.imul(hash,16777619)>>>0; });
    return '00' + String(hash % 1000000000).padStart(9,'0');
  }
  function safePart(value) { return String(value ?? '').replace(/[¦§\r\n]+/g,' ').replace(/\s+/g,' ').trim(); }
  function structuredAnswer(data) {
    const vals=[data.q1_prefeitura,data.q2_prefeitura,data.q3_prefeitura,data.q4_prefeitura,data.q5_prefeitura,data.q6_prefeitura,data.q7_prefeitura,data.q8_prefeitura,data.bairro_regiao,data.q10_prefeitura,data.q11_prefeitura];
    return 'PREFEITURA_V2¦'+vals.map((v,i)=>`q${i+1}§${safePart(v)}`).join('¦');
  }
  function legacyPayload(data, submissionId) {
    const p1={ 'Muito boa':'5','Boa':'4','Regular':'3','Ruim':'2' }[data.q1_prefeitura];
    const p2={ 'Sim':'5','Mais ou menos':'3','Não':'1' }[data.q2_prefeitura];
    const p3={ 'Muito':'Sim','Sim':'Sim','Pouco':'Parcialmente','Não':'Não' }[data.q3_prefeitura];
    const p5={ 'Sim':'Sim','Talvez':'Parcialmente','Não':'Não' }[data.q5_prefeitura];
    return {
      submission_id:submissionId,
      nome:'PESQUISA_ANONIMA_PREFEITURA_V2', celular:syntheticPhone(submissionId),
      espetaculo:data.espetaculo, local:data.local, bairro_regiao:data.bairro_regiao,
      p1,p2,p3,p4:'Não sei avaliar',p5,p6:'Não',p6_barreira_detalhe:'',p7:data.q5_prefeitura,
      p8:structuredAnswer(data), privacidade_ciente:'true'
    };
  }

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function requestStatus(submissionId) {
    const cfg=config();
    return new Promise((resolve,reject)=>{
      const cb=`pulsaStatus_${submissionId.replace(/[^A-Za-z0-9_]/g,'')}_${Date.now()}`;
      const script=document.createElement('script');
      const cleanup=()=>{ delete global[cb]; script.remove(); };
      global[cb]=payload=>{ cleanup(); resolve(payload||{ok:false,pending:true}); };
      script.onerror=()=>{ cleanup(); reject(new Error('STATUS_NETWORK_ERROR')); };
      const url=new URL(cfg.WEB_APP_URL); url.searchParams.set('action','status'); url.searchParams.set('submission_id',submissionId); url.searchParams.set('callback',cb); url.searchParams.set('_',String(Date.now())); script.src=url.toString(); document.head.appendChild(script);
    });
  }
  async function pollStatus(submissionId) {
    const cfg=config(), start=Date.now();
    while(Date.now()-start<cfg.STATUS_TIMEOUT_MS){ try{ const s=await requestStatus(submissionId); if(!s.pending) return s; }catch(_e){} await sleep(cfg.STATUS_POLL_MS); }
    throw new Error('STATUS_TIMEOUT');
  }

  function setupBrowser(){
    const form=document.getElementById('pulsa-form'); if(!form) return;
    const submitButton=document.getElementById('submit-button'), retryButton=document.getElementById('retry-button'), statusEl=document.getElementById('form-status'), errorSummary=document.getElementById('error-summary'), successPanel=document.getElementById('success-panel'), submissionInput=document.getElementById('submission-id');
    let sending=false;
    const setStatus=(m,k)=>{statusEl.textContent=m||'';statusEl.className=`form-status${k?` is-${k}`:''}`;};
    const setSending=v=>{sending=v;submitButton.disabled=v;submitButton.querySelector('.submit-button__label').textContent=v?'Enviando sua avaliação…':'Enviar minha avaliação';};
    function clearErrors(){form.querySelectorAll('.has-error').forEach(el=>el.classList.remove('has-error'));form.querySelectorAll('[aria-invalid="true"]').forEach(el=>el.removeAttribute('aria-invalid'));errorSummary.hidden=true;errorSummary.textContent='';}
    function renderErrors(errors){clearErrors();const keys=Object.keys(errors);if(!keys.length)return;keys.forEach(key=>{const g=form.querySelector(`[data-field="${key}"]`);if(g)g.classList.add('has-error');const c=form.querySelector(`[name="${key}"]`);if(c)c.setAttribute('aria-invalid','true');});errorSummary.textContent='Revise os campos destacados antes de enviar.';errorSummary.hidden=false;const first=form.querySelector(`[name="${keys[0]}"]`);if(first&&first.focus)first.focus();}
    function visibleData(){const fd=new FormData(form), obj={};['espetaculo','local','bairro_regiao','q1_prefeitura','q2_prefeitura','q3_prefeitura','q4_prefeitura','q5_prefeitura','q6_prefeitura','q7_prefeitura','q8_prefeitura','q10_prefeitura','q11_prefeitura'].forEach(k=>obj[k]=String(fd.get(k)||''));return obj;}
    function saveDraft(data){try{sessionStorage.setItem(config().DRAFT_KEY,JSON.stringify(data));}catch(_e){}}
    function clearDraft(){try{sessionStorage.removeItem(config().DRAFT_KEY);}catch(_e){}}
    function restoreDraft(){let data=null;try{data=JSON.parse(sessionStorage.getItem(config().DRAFT_KEY)||'null');}catch(_e){}if(!data)return;Object.entries(data).forEach(([name,value])=>{const controls=form.querySelectorAll(`[name="${name}"]`);if(!controls.length)return;if(controls[0].type==='radio')controls.forEach(c=>c.checked=c.value===value);else controls[0].value=value??'';});}
    function applyLegacy(payload){Object.entries(payload).forEach(([name,value])=>{const c=form.elements[name];if(c&&c.type==='hidden')c.value=value;});}
    function configuredUrl(){const v=String(config().WEB_APP_URL||'').trim();return /^https:\/\//.test(v)&&/\/exec(?:$|\?)/.test(v)?v:'';}
    async function submitEvaluation(event){
      if(event)event.preventDefault(); if(sending)return; clearErrors();retryButton.hidden=true;setStatus('','');
      const data=visibleData(), validation=validateForm(data); if(!validation.ok){renderErrors(validation.errors);setStatus('Há informações que precisam ser revistas.','error');return;}
      const endpoint=configuredUrl(); if(!endpoint){setStatus('O formulário ainda não foi conectado ao serviço de envio. Avise a equipe do PULSA SP.','error');return;}
      if(!submissionInput.value)submissionInput.value=createSubmissionId();
      const legacy=legacyPayload(data,submissionInput.value); applyLegacy(legacy); saveDraft(data); setSending(true);setStatus('Enviando sua avaliação…',''); form.action=endpoint;form.target='pulsa-submit-frame';HTMLFormElement.prototype.submit.call(form);
      try{const result=await pollStatus(submissionInput.value);if(!result||!result.ok)throw new Error(result&&result.error?result.error:'STATUS_REJECTED');clearDraft();setStatus('Avaliação registrada com sucesso.','success');form.hidden=true;successPanel.hidden=false;successPanel.scrollIntoView({behavior:'smooth',block:'center'});}catch(err){setSending(false);retryButton.hidden=false;setStatus(err&&err.message==='STATUS_TIMEOUT'?'Não conseguimos confirmar o envio agora. Sua resposta continua neste aparelho. Toque em “Tentar novamente”.':'Não foi possível concluir o envio. Tente novamente.','error');}
    }
    form.addEventListener('submit',submitEvaluation);retryButton.addEventListener('click',()=>submitEvaluation());restoreDraft();
  }

  global.PULSA_APP={validateForm,createSubmissionId,syntheticPhone,structuredAnswer,legacyPayload,pollStatus};
  if(typeof document!=='undefined'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setupBrowser);else setupBrowser();}
})(typeof window!=='undefined'?window:globalThis);
