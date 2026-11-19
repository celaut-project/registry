<script lang="ts">
  import { WalletButton, walletConnected } from 'wallet-svelte-component';
  import { web_explorer_uri_addr } from '$lib/common/store';
  import { objectives } from '$lib/stores';
  import { toasts } from './toastStore';
  import SubmitFormEnhancements from './SubmitFormEnhancements.svelte';
  import FormalSpecEditor from './FormalSpecEditor.svelte';
  import { createObjective } from '$lib/data';
  import { demoMode } from '$lib/config';
  import { reputation_proof } from '$lib/common/store';
  import { getMainReputationBox } from '$lib/reputationContext';

  function currentMainBox() {
    return getMainReputationBox($reputation_proof);
  }

  // Submit form state
  let newObjectiveName = '';
  let newObjectiveProse = '';
  let newObjectiveFormal = '';
  let newObjectiveTags = '';
  let newObjectiveDomain = '';
  let relatedObjectiveBoxIds: string[] = [];
  let submitting = false;
  let submitTx: string | null = null;
  let submitError: string | null = null;
  let validationErrors: Record<string, string> = {};

  let enhancementsRef: SubmitFormEnhancements;

  async function handleSubmitObjective() {
    // Run validation from enhancements component
    if (enhancementsRef) {
      validationErrors = enhancementsRef.validate();
      if (Object.keys(validationErrors).length > 0) {
        toasts.error('Please fix the form errors before submitting.');
        return;
      }
    }

    if (!$walletConnected) {
      submitError = 'Connect your wallet first.';
      toasts.error('Connect your wallet first.');
      return;
    }
    if (!newObjectiveName.trim()) {
      submitError = 'Name is required.';
      validationErrors = { name: 'Objective name is required.' };
      return;
    }
    submitting = true;
    submitError = null;
    submitTx = null;
    try {
      // Routes to ergoProvider.createObjective in chain mode (mints an Objective Type
      // NFT via reputation-system's create_opinion against OBJECTIVE_TYPE_ID) or
      // to mockDb.createObjective in demo mode. Mirrors handleSubmitObjective in
      // App.svelte / handleCreateBenchmark / etc.
      const txId = await createObjective({
        name: newObjectiveName.trim(),
        prose: newObjectiveProse.trim(),
        formal: newObjectiveFormal.trim(),
        tags: newObjectiveTags.split(',').map((t) => t.trim()).filter(Boolean),
        domain: newObjectiveDomain.trim(),
        extendedObjectiveBoxIds: [...relatedObjectiveBoxIds],
        sourceHash: '',
        tokenAmount: 1,
        mainBox: currentMainBox()
      });
      submitTx = txId;
      toasts.success($demoMode ? 'Objective submitted successfully (demo mode).' : 'Objective published on-chain.');
      newObjectiveName = '';
      newObjectiveProse = '';
      newObjectiveFormal = '';
      newObjectiveDomain = '';
      newObjectiveTags = '';
      relatedObjectiveBoxIds = [];
    } catch (e: any) {
      submitError = e.message || 'Submission failed.';
      toasts.error(submitError || 'Submission failed.');
    } finally {
      submitting = false;
    }
  }

  // Clear validation errors when fields change
  $: if (newObjectiveName) { delete validationErrors['name']; validationErrors = validationErrors; }
  $: if (newObjectiveProse) { delete validationErrors['prose']; validationErrors = validationErrors; }
  $: if (newObjectiveDomain) { delete validationErrors['domain']; validationErrors = validationErrors; }
</script>

<div class="w-full">
  <h2 class="text-2xl font-bold mb-2">Submit an Objective</h2>
  <p class="text-muted-foreground mb-6 text-sm">
    Objectives are published on-chain as Reputation Boxes. Connect your wallet to sign.
  </p>

  {#if !$walletConnected}
    <div class="card text-center py-8">
      <p class="text-muted-foreground mb-4">Connect your wallet to submit an objective.</p>
      <WalletButton explorerUrl={$web_explorer_uri_addr} />
    </div>
  {:else}
    <form on:submit|preventDefault={handleSubmitObjective} class="space-y-4">
      <div>
        <label class="label" for="objective-name">Name <span class="text-red-500">*</span></label>
        <input id="objective-name" class="input" class:input-error={validationErrors['name']} bind:value={newObjectiveName} placeholder="e.g. Optimal XAU/BTC Performance" required />
        {#if validationErrors['name']}
          <p class="field-error">{validationErrors['name']}</p>
        {/if}
      </div>
      <div>
        <label class="label" for="objective-prose">Description</label>
        <textarea id="objective-prose" class="input min-h-[100px] resize-y" class:input-error={validationErrors['prose']} bind:value={newObjectiveProse} placeholder="What problem does this objective solve?"></textarea>
        {#if validationErrors['prose']}
          <p class="field-error">{validationErrors['prose']}</p>
        {/if}
      </div>
      <div>
        <label class="label" for="objective-domain">Domain</label>
        <input id="objective-domain" class="input" class:input-error={validationErrors['domain']} bind:value={newObjectiveDomain} placeholder="e.g. finance, infrastructure, nlp" />
        {#if validationErrors['domain']}
          <p class="field-error">{validationErrors['domain']}</p>
        {/if}
      </div>
      <div>
        <label class="label" for="objective-tags">Tags <span class="text-muted-foreground font-normal">(comma-separated)</span></label>
        <input id="objective-tags" class="input" bind:value={newObjectiveTags} placeholder="trading, gold, bitcoin" />
      </div>
      <div>
        <label class="label" for="objective-formal">Formal specification <span class="text-muted-foreground font-normal">(optional, JSON)</span></label>
        <FormalSpecEditor id="objective-formal" bind:value={newObjectiveFormal} schema={null} />
      </div>

      <!-- Enhanced form sections -->
      <SubmitFormEnhancements
        bind:this={enhancementsRef}
        objectives={$objectives}
        name={newObjectiveName}
        prose={newObjectiveProse}
        domain={newObjectiveDomain}
        tags={newObjectiveTags}
        errors={validationErrors}
        on:relatedChange={(event) => (relatedObjectiveBoxIds = event.detail)}
      />

      <button type="submit" class="btn-primary w-full" disabled={submitting}>
        {submitting ? 'Publishing…' : 'Publish Objective On-Chain'}
      </button>
    </form>

    {#if submitTx}
      <div class="mt-4 p-4 rounded-md bg-green-100 dark:bg-green-900 border border-green-400 text-sm">
        <p class="font-semibold text-green-800 dark:text-green-200">Objective submitted!</p>
        <a href={`https://explorer.ergoplatform.com/en/transactions/${submitTx}`} target="_blank" rel="noopener noreferrer" class="text-blue-600 dark:text-blue-400 break-all">{submitTx}</a>
      </div>
    {/if}
    {#if submitError}
      <div class="mt-4 p-4 rounded-md bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-300 text-sm text-yellow-800 dark:text-yellow-200">
        {submitError}
      </div>
    {/if}
  {/if}
</div>

<style lang="postcss">
  .card {
    @apply p-4 rounded-lg border border-border bg-card;
  }

  .label {
    @apply block text-sm font-medium mb-1 text-foreground;
  }

  .input {
    @apply w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring;
  }

  .input-error {
    border-color: hsl(var(--destructive));
  }
  .input-error:focus {
    box-shadow: 0 0 0 2px hsl(var(--destructive) / 0.3);
  }

  .field-error {
    margin-top: 0.25rem;
    font-size: 0.75rem;
    color: hsl(var(--destructive));
  }

  .btn-primary {
    @apply px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium transition-colors;
  }
  .btn-primary:hover:not(:disabled) {
    @apply opacity-90;
  }
  .btn-primary:disabled {
    @apply opacity-50 cursor-not-allowed;
  }
</style>
