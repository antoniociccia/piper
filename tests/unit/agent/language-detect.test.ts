import { describe, expect, test } from 'bun:test';

import { detectLanguage } from '../../../src/agent/language-detect.ts';

describe('detectLanguage', () => {
  test('English: short / ambiguous / techy prompts default to English', () => {
    expect(detectLanguage('uptime?')).toBe('English');
    expect(detectLanguage('ls /tmp')).toBe('English');
    expect(detectLanguage('docker ps')).toBe('English');
    expect(detectLanguage('check disk on staging')).toBe('English');
    expect(detectLanguage('why is the worker dead')).toBe('English');
  });

  test('Italian: typical Italian SRE prompts', () => {
    expect(detectLanguage('analizza il container')).toBe('Italian');
    expect(detectLanguage('perché il worker è morto')).toBe('Italian');
    expect(detectLanguage('verifica lo stato della macchina')).toBe('Italian');
    expect(detectLanguage('controlla uptime e disco su staging')).toBe('Italian');
    expect(detectLanguage('dammi una panoramica del sistema')).toBe('Italian');
    expect(detectLanguage("cos'è successo al redis?")).toBe('Italian');
  });

  test('Spanish: typical Spanish prompts', () => {
    expect(detectLanguage('verifica el estado de los contenedores')).toBe('Spanish');
    expect(detectLanguage('por qué está caído el servicio')).toBe('Spanish');
    expect(detectLanguage('comprobar el disco y la memoria')).toBe('Spanish');
  });

  test('French: typical French prompts', () => {
    expect(detectLanguage('vérifie l\'état des conteneurs')).toBe('French');
    expect(detectLanguage('pourquoi le worker est mort')).toBe('French');
    expect(detectLanguage('analyse le système et montre les erreurs')).toBe('French');
  });

  test('German: typical German prompts', () => {
    expect(detectLanguage('überprüfe den status der container')).toBe('German');
    expect(detectLanguage('warum ist der worker tot')).toBe('German');
    expect(detectLanguage('zeige mir die fehler und nicht die warnungen')).toBe('German');
  });

  test('Portuguese: typical Portuguese prompts', () => {
    expect(detectLanguage('verifique o estado dos contêineres')).toBe('Portuguese');
    expect(detectLanguage('por que o worker não está funcionando')).toBe('Portuguese');
    expect(detectLanguage('analise o sistema e mostre os erros')).toBe('Portuguese');
  });

  test('does not misclassify single trigger words', () => {
    // "el" alone is too weak — needs at least score 2.
    expect(detectLanguage('el')).toBe('English');
    // "il" alone too.
    expect(detectLanguage('il')).toBe('English');
  });
});
