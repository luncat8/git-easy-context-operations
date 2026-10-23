/**
 * The stale-window case behind "No view is registered with id: ...": only the
 * workbench's exact error counts as "reload the window", and the report says
 * which views are missing and why - once.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
	RELOAD_WINDOW_ACTION,
	describeUnavailableViews,
	isMissingViewError,
	missingViewId,
	quotedLabelList,
} from '../../core/viewAvailability';

describe('view availability - recognising the stale-window error', () => {
	it('names the view id the workbench refused', () => {
		const error = new Error('No view is registered with id: geco.dialogDecisions');
		assert.equal(missingViewId(error), 'geco.dialogDecisions');
		assert.equal(isMissingViewError(error), true);
	});

	it('accepts the same wording as a plain string', () => {
		assert.equal(isMissingViewError('Error: No view is registered with id: geco.menuEditor'), true);
	});

	it('does not mistake another failure for it', () => {
		assert.equal(isMissingViewError(new Error('Cannot read properties of undefined')), false);
		assert.equal(isMissingViewError(undefined), false);
		assert.equal(isMissingViewError({ message: 'No view is registered with id: x' }), false);
		assert.equal(isMissingViewError('no view is registered'), false);
	});
});

describe('view availability - the report', () => {
	it('shows nothing when every view exists', () => {
		assert.equal(describeUnavailableViews([]), undefined);
		assert.equal(describeUnavailableViews(['', '   ']), undefined);
	});

	it('speaks of one view in the singular', () => {
		const report = describeUnavailableViews(['Git Easy Ops Dialog Decisions']);
		assert.ok(report);
		assert.match(report.message, /the "Git Easy Ops Dialog Decisions" view is not available in this window yet/);
		assert.equal(report.action, RELOAD_WINDOW_ACTION);
	});

	it('lists several views in the plural, without repeats', () => {
		const report = describeUnavailableViews(['Menu Editor', 'Dialog Decisions', 'Menu Editor']);
		assert.ok(report);
		assert.match(report.message, /the "Menu Editor" and "Dialog Decisions" views are not available/);
	});

	it('points at the reload, and says that the rest keeps working', () => {
		const report = describeUnavailableViews(['Dialog Decisions']);
		assert.ok(report);
		assert.match(report.detail, /reloaded/);
		assert.ok(report.detail.includes('"Reload Window" finishes the update.'));
		assert.match(report.detail, /saved dialog decisions/);
		assert.doesNotMatch(report.detail, /Failed|failed|error/i);
	});

	it('formats label lists the way the sentences read', () => {
		assert.equal(quotedLabelList([]), '');
		assert.equal(quotedLabelList(['A']), '"A"');
		assert.equal(quotedLabelList(['A', 'B']), '"A" and "B"');
		assert.equal(quotedLabelList(['A', 'B', 'C']), '"A", "B" and "C"');
	});
});
