import { describe, expect, it } from 'vitest';
import {
  fileNameExtension,
  isGmailBlockedExtension,
  hasGmailBlockedExtension,
} from './replyAttachments.js';

describe('fileNameExtension', () => {
  it('takes the last dot, lower-cased, and has none for dotless, dot-leading or dot-trailing names', () => {
    expect(fileNameExtension('Rate card.PDF')).toBe('pdf');
    expect(fileNameExtension('archive.tar.gz')).toBe('gz');
    expect(fileNameExtension('README')).toBeUndefined();
    expect(fileNameExtension('.env')).toBeUndefined();
    expect(fileNameExtension('trailing.')).toBeUndefined();
  });
});

describe('hasGmailBlockedExtension', () => {
  it('refuses what Gmail refuses, whatever the case, and takes everything else', () => {
    expect(hasGmailBlockedExtension('setup.exe')).toBe(true);
    expect(hasGmailBlockedExtension('Macro.JS')).toBe(true);
    expect(hasGmailBlockedExtension('tracking.xlsx')).toBe(false);
    expect(hasGmailBlockedExtension('photo')).toBe(false);
    expect(isGmailBlockedExtension('EXE')).toBe(true);
    expect(isGmailBlockedExtension('pdf')).toBe(false);
  });
});
