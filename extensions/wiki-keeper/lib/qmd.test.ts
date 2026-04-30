import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isQmdStatusTextEmpty } from "./qmd.ts";

describe("qmd — isQmdStatusTextEmpty", () => {
	it("matches '0 documents'", () => {
		assert.equal(isQmdStatusTextEmpty("Collection: foo\n0 documents"), true);
	});

	it("matches '0 document' (singular)", () => {
		assert.equal(isQmdStatusTextEmpty("0 document indexed"), true);
	});

	it("matches 'documents: 0'", () => {
		assert.equal(isQmdStatusTextEmpty("status\ndocuments: 0\nready"), true);
	});

	it("matches 'document = 0'", () => {
		assert.equal(isQmdStatusTextEmpty("document = 0"), true);
	});

	it("matches 'no documents'", () => {
		assert.equal(isQmdStatusTextEmpty("collection has no documents"), true);
	});

	it("matches 'no document' (singular)", () => {
		assert.equal(isQmdStatusTextEmpty("no document found"), true);
	});

	it("matches 'collection empty'", () => {
		assert.equal(isQmdStatusTextEmpty("Status: collection empty"), true);
	});

	it("is case-insensitive", () => {
		assert.equal(isQmdStatusTextEmpty("0 DOCUMENTS"), true);
		assert.equal(isQmdStatusTextEmpty("NO DOCUMENTS"), true);
	});

	it("returns false for non-empty collection text", () => {
		assert.equal(isQmdStatusTextEmpty("42 documents indexed"), false);
		assert.equal(isQmdStatusTextEmpty("collection foo: 1 document, ready"), false);
	});

	it("returns false for unrelated stderr text", () => {
		assert.equal(isQmdStatusTextEmpty("", "warning: something"), false);
	});

	it("returns false for empty input", () => {
		assert.equal(isQmdStatusTextEmpty(""), false);
		assert.equal(isQmdStatusTextEmpty("", ""), false);
	});

	it("checks both stdout and stderr", () => {
		assert.equal(isQmdStatusTextEmpty("", "0 documents"), true);
	});

	it("does not false-positive on '10 documents' or similar", () => {
		assert.equal(isQmdStatusTextEmpty("10 documents"), false, "should not match because regex uses \\b0\\b");
		assert.equal(isQmdStatusTextEmpty("100 documents"), false);
	});
});
