/** The public rail: four steps collapsed to their titles, with step 1 open and
 * carrying the paste-into-your-own-LLM audit prompt above an OS-aware install
 * command. No key surface may ever appear here. */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithClient } from '../test/utils';
import { LandingOnboardingGuide } from './LandingOnboardingGuide';

/** Step titles are disclosure buttons; open the one we want to inspect. */
async function openStep(name: RegExp) {
  await userEvent.click(screen.getByRole('button', { name }));
}

describe('LandingOnboardingGuide', () => {
  it('is four steps, install first, before anything touching Gate', () => {
    renderWithClient(<LandingOnboardingGuide />);

    // Only the four step headings are top-level; the Gate step's own ordered
    // list nests inside step 2, so scope to the outer <ol>.
    const steps = screen.getAllByRole('listitem').filter((li) => li.querySelector('h3'));
    expect(steps).toHaveLength(4);
    expect(within(steps[0]).getByRole('heading')).toHaveTextContent('Install the terminal');
    expect(within(steps[1]).getByRole('heading')).toHaveTextContent(
      'Fund Gate and enable CrossEx',
    );
    expect(within(steps[2]).getByRole('heading')).toHaveTextContent('Create your API key');
    expect(within(steps[3]).getByRole('heading')).toHaveTextContent('Execute');
  });

  it('keeps the three Gate errands, in order, inside the one step', async () => {
    renderWithClient(<LandingOnboardingGuide />);
    await openStep(/^Fund Gate and enable CrossEx/);

    // The nested <li>s are the errands — the step <li>s carry an <h3>.
    const errands = screen
      .getAllByRole('listitem')
      .filter((li) => !li.querySelector('h3'))
      .map((li) => li.textContent ?? '');
    expect(errands).toHaveLength(3);
    // Enabling CrossEx must precede moving funds into it, and both precede the
    // API key — that ordering is the reason this is a list and not a sentence.
    expect(errands[0]).toMatch(/gate\.com\/signup/);
    expect(errands[1]).toMatch(/Switch on CrossEx/);
    expect(errands[2]).toMatch(/Move your funds into CrossEx/);
  });

  it('offers the audit inside step 1, above the install command', () => {
    renderWithClient(<LandingOnboardingGuide />);

    const install = within(screen.getAllByRole('listitem')[0]);
    const audit = install.getByRole('button', { name: 'Copy audit prompt' });
    const command = install.getByRole('button', { name: 'Copy command' });
    // Both live in step 1, and reading the source comes before running it.
    expect(audit).toBeVisible();
    expect(command).toBeVisible();
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(audit.compareDocumentPosition(command) & FOLLOWING).toBeTruthy();
    // ...and not the other way round, so the direction is genuinely pinned.
    expect(command.compareDocumentPosition(audit) & FOLLOWING).toBeFalsy();
  });

  it('opens step 1 and collapses the rest', () => {
    renderWithClient(<LandingOnboardingGuide />);

    expect(screen.getByRole('button', { name: /^Install the terminal/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(3);
    // A collapsed body is mounted but hidden, so nothing inside it is reachable.
    expect(screen.getByText(/gate\.com\/signup/)).not.toBeVisible();
    expect(screen.getByText(/\/bin\/bash -c/)).toBeVisible();
  });

  it('expands a step on click and collapses it again', async () => {
    renderWithClient(<LandingOnboardingGuide />);

    await openStep(/^Fund Gate/);
    const header = screen.getByRole('button', { name: /^Fund Gate/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/gate\.com\/signup/)).toBeVisible();

    await userEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(/gate\.com\/signup/)).not.toBeVisible();
  });

  it('offers the audit prompt with the questions that matter for a key-holding tool', () => {
    renderWithClient(<LandingOnboardingGuide />);

    const prompt = screen.getByText(/Audit this open-source tool/);
    expect(prompt).toHaveTextContent('github.com/mrenoon/crossex-boros-terminal');
    expect(prompt).toHaveTextContent(/send my API keys.*off my machine/s);
    expect(prompt).toHaveTextContent(/withdraw funds/);
    expect(prompt).toHaveTextContent(/install\.sh \(macOS\) and install\.ps1 \(Windows\)/);
  });

  it('defaults to the macOS install command and swaps to PowerShell on demand', async () => {
    // jsdom's userAgent is not Windows, so detectOs() lands on macOS. Step 1 is
    // open by default, so the command is on screen already.
    renderWithClient(<LandingOnboardingGuide />);

    expect(screen.getByText(/\/bin\/bash -c/)).toBeInTheDocument();
    expect(screen.queryByText(/install\.ps1 \| iex/)).toBeNull();

    await userEvent.click(screen.getByRole('radio', { name: 'Windows' }));

    expect(screen.getByText(/install\.ps1 \| iex/)).toBeInTheDocument();
    expect(screen.queryByText(/\/bin\/bash -c/)).toBeNull();
    expect(screen.getByText(/press Win, type PowerShell/)).toBeInTheDocument();
  });

  it('never renders a credential input on the public page', async () => {
    renderWithClient(<LandingOnboardingGuide />);
    // Even with every step opened.
    for (const t of [/^Install the terminal/, /^Create your API key/, /^Execute/]) {
      await openStep(t);
    }

    expect(screen.queryByLabelText(/API key/i)).toBeNull();
    expect(screen.queryByLabelText(/API secret/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Save credentials/i })).toBeNull();
  });
});
