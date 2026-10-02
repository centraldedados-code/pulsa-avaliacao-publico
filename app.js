(function (global) {
  'use strict';

  const DEFAULT_CONFIG = {
    WEB_APP_URL: '',
    STATUS_TIMEOUT_MS: 15000,
    STATUS_POLL_MS: 1000,
    DRAFT_KEY: 'pulsa-avaliacao-rascunho-v1'
  };

  function config() {
    return Object.assign({}, DEFAULT_CONFIG, global.PULSA_CONFIG || {});
  }

  function normalizePhone(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) digits = digits.slice(2);
    return digits;
  }

  function truthy(value) {
    return ['true', '1', 'on', 'sim', 'yes'].includes(String(value ?? '').toLowerCase());
  }

  function getValue(source, key) {
    if (source && typeof source.get === 'function') return source.get(key);
    return source ? source[key] : undefined;
  }

  function validateForm(source) {
    const errors = {};
    const text = (key) => String(getValue(source, key) ?? '').trim();
    const requiredText = (key, max, message) => {
      const value = text(key);
      if (!value) errors[key] = message || 'Este campo é obrigatório.';
      else if (value.length > max) errors[key] = `Use no máximo ${max} caracteres.`;
      return value;
    };
    const choice = (key, allowed) => {
      const value = text(key);
      if (!allowed.includes(value)) errors[key] = 'Escolha uma opção.';
      return value;
    };

    requiredText('nome', 120, 'Informe seu nome completo.');
    const phoneOriginal = requiredText('celular', 40, 'Informe seu celular/WhatsApp.');
    const phone = normalizePhone(phoneOriginal);
    if (phoneOriginal && ![10, 11].includes(phone.length)) errors.celular = 'Informe um celular brasileiro válido com DDD.';
    requiredText('espetaculo', 200, 'Informe o nome do espetáculo ou atividade.');
    requiredText('local', 200, 'Informe onde a atividade aconteceu.');
    const bairro = text('bairro_regiao');
    if (bairro.length > 120) errors.bairro_regiao = 'Use no máximo 120 caracteres.';

    choice('p1', ['1', '2', '3', '4', '5']);
    choice('p2', ['1', '2', '3', '4', '5']);
    choice('p3', ['Sim', 'Parcialmente', 'Não']);
    choice('p4', ['Sim', 'Parcialmente', 'Não', 'Não sei avaliar']);
    choice('p5', ['Sim', 'Parcialmente', 'Não']);
    const barrier = choice('p6', ['Sim', 'Não']);
    choice('p7', ['Sim', 'Talvez', 'Não']);

    const barrierDetail = text('p6_barreira_detalhe');
    if (barrier === 'Sim' && !barrierDetail) errors.p6_barreira_detalhe = 'Conte brevemente qual foi a barreira encontrada.';
    if (barrierDetail.length > 500) errors.p6_barreira_detalhe = 'Use no máximo 500 caracteres.';
    const comment = text('p8');
    if (comment.length > 1500) errors.p8 = 'Use no máximo 1500 caracteres.';

    if (!truthy(getValue(source, 'privacidade_ciente'))) errors.privacidade_ciente = 'É preciso confirmar a ciência sobre o uso dos dados.';
    return { ok: Object.keys(errors).length === 0, errors };
  }

  function createSubmissionId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    const random = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return `${random()}${random()}-${random()}-4${random().slice(1)}-8${random().slice(1)}-${random()}${random()}${random()}`;
  }

  function formatPhone(value) {
    const digits = normalizePhone(value).slice(0, 11);
    if (digits.length <= 2) return digits ? `(${digits}` : '';
    if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
    if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requestStatus(submissionId) {
    const cfg = config();
    return new Promise((resolve, reject) => {
      const callbackName = `pulsaStatus_${submissionId.replace(/[^A-Za-z0-9_]/g, '')}_${Date.now()}`;
      const script = document.createElement('script');
      const cleanup = () => {
        delete global[callbackName];
        script.remove();
      };
      global[callbackName] = (payload) => {
        cleanup();
        resolve(payload || { ok: false, pending: true });
      };
      script.onerror = () => {
        cleanup();
        reject(new Error('STATUS_NETWORK_ERROR'));
      };
      const url = new URL(cfg.WEB_APP_URL);
      url.searchParams.set('action', 'status');
      url.searchParams.set('submission_id', submissionId);
      url.searchParams.set('callback', callbackName);
      url.searchParams.set('_', String(Date.now()));
      script.src = url.toString();
      document.head.appendChild(script);
    });
  }

  async function pollStatus(submissionId) {
    const cfg = config();
    const startedAt = Date.now();
    while (Date.now() - startedAt < cfg.STATUS_TIMEOUT_MS) {
      try {
        const status = await requestStatus(submissionId);
        if (!status.pending) return status;
      } catch (_err) {
        // A consulta será tentada novamente até o timeout total.
      }
      await sleep(cfg.STATUS_POLL_MS);
    }
    throw new Error('STATUS_TIMEOUT');
  }

  function setupBrowser() {
    const form = document.getElementById('pulsa-form');
    if (!form) return;
    const submitButton = document.getElementById('submit-button');
    const retryButton = document.getElementById('retry-button');
    const statusEl = document.getElementById('form-status');
    const errorSummary = document.getElementById('error-summary');
    const successPanel = document.getElementById('success-panel');
    const barrierWrap = document.getElementById('barreira-detalhe-wrap');
    const barrierDetail = document.getElementById('p6-barreira-detalhe');
    const submissionInput = document.getElementById('submission-id');
    const phoneInput = document.getElementById('celular');
    const comment = document.getElementById('p8');
    const commentCounter = document.getElementById('p8-counter');
    let sending = false;

    function setStatus(message, kind) {
      statusEl.textContent = message || '';
      statusEl.className = `form-status${kind ? ` is-${kind}` : ''}`;
    }

    function setSending(isSending) {
      sending = isSending;
      submitButton.disabled = true;
      if (!isSending) submitButton.disabled = false;
      submitButton.querySelector('.submit-button__label').textContent = isSending ? 'Enviando sua avaliação…' : 'Enviar minha avaliação';
    }

    function clearErrors() {
      form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
      form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
      errorSummary.hidden = true;
      errorSummary.textContent = '';
    }

    function renderErrors(errors) {
      clearErrors();
      const keys = Object.keys(errors);
      if (!keys.length) return;
      keys.forEach((key) => {
        const group = form.querySelector(`[data-field="${key}"]`);
        if (group) group.classList.add('has-error');
        const control = form.querySelector(`[name="${key}"]`);
        if (control) control.setAttribute('aria-invalid', 'true');
      });
      errorSummary.textContent = 'Revise os campos destacados antes de enviar.';
      errorSummary.hidden = false;
      const first = form.querySelector(`[name="${keys[0]}"]`);
      if (first && typeof first.focus === 'function') first.focus();
    }

    function formObject() {
      const fd = new FormData(form);
      const data = Object.fromEntries(fd.entries());
      data.privacidade_ciente = form.elements.privacidade_ciente.checked ? 'true' : '';
      return data;
    }

    function saveDraft(data) {
      try { sessionStorage.setItem(config().DRAFT_KEY, JSON.stringify(data)); } catch (_err) {}
    }

    function clearDraft() {
      try { sessionStorage.removeItem(config().DRAFT_KEY); } catch (_err) {}
    }

    function restoreDraft() {
      let data = null;
      try { data = JSON.parse(sessionStorage.getItem(config().DRAFT_KEY) || 'null'); } catch (_err) {}
      if (!data) return;
      Object.entries(data).forEach(([name, value]) => {
        if (name === 'privacidade_ciente') {
          form.elements.privacidade_ciente.checked = truthy(value);
          return;
        }
        const controls = form.querySelectorAll(`[name="${name}"]`);
        if (!controls.length) return;
        if (controls[0].type === 'radio') {
          controls.forEach((control) => { control.checked = control.value === value; });
        } else {
          controls[0].value = value ?? '';
        }
      });
      updateBarrierState();
      updateCounter();
    }

    function updateBarrierState() {
      const selected = form.querySelector('input[name="p6"]:checked');
      const show = selected && selected.value === 'Sim';
      barrierWrap.hidden = !show;
      barrierDetail.required = !!show;
      if (!show) barrierDetail.value = '';
    }

    function updateCounter() {
      commentCounter.textContent = `${comment.value.length}/1500`;
    }

    function configuredUrl() {
      const value = String(config().WEB_APP_URL || '').trim();
      return /^https:\/\//.test(value) && /\/exec(?:$|\?)/.test(value) ? value : '';
    }

    async function submitEvaluation(event) {
      if (event) event.preventDefault();
      if (sending) return;
      clearErrors();
      retryButton.hidden = true;
      setStatus('', '');

      const data = formObject();
      const validation = validateForm(data);
      if (!validation.ok) {
        renderErrors(validation.errors);
        setStatus('Há informações que precisam ser revistas.', 'error');
        return;
      }

      const endpoint = configuredUrl();
      if (!endpoint) {
        setStatus('O formulário ainda não foi conectado ao serviço de envio. Avise a equipe do PULSA SP.', 'error');
        return;
      }

      if (!submissionInput.value) submissionInput.value = createSubmissionId();
      data.submission_id = submissionInput.value;
      saveDraft(data);
      setSending(true);
      setStatus('Enviando sua avaliação…', '');

      form.action = endpoint;
      form.target = 'pulsa-submit-frame';
      HTMLFormElement.prototype.submit.call(form);

      try {
        const result = await pollStatus(submissionInput.value);
        if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'STATUS_REJECTED');
        clearDraft();
        setStatus('Avaliação registrada com sucesso.', 'success');
        form.hidden = true;
        successPanel.hidden = false;
        successPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (err) {
        setSending(false);
        retryButton.hidden = false;
        if (err && err.message === 'STATUS_TIMEOUT') {
          setStatus('Não conseguimos confirmar o envio agora. Seus dados continuam neste aparelho. Toque em “Tentar novamente”.', 'error');
        } else {
          setStatus('Não foi possível concluir o envio. Tente novamente.', 'error');
        }
      }
    }

    form.addEventListener('submit', submitEvaluation);
    retryButton.addEventListener('click', () => submitEvaluation());
    form.querySelectorAll('input[name="p6"]').forEach((radio) => radio.addEventListener('change', updateBarrierState));
    phoneInput.addEventListener('input', () => { phoneInput.value = formatPhone(phoneInput.value); });
    comment.addEventListener('input', updateCounter);
    restoreDraft();
  }

  const api = { normalizePhone, validateForm, createSubmissionId, pollStatus };
  global.PULSA_APP = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupBrowser);
    else setupBrowser();
  }
})(typeof window !== 'undefined' ? window : globalThis);
