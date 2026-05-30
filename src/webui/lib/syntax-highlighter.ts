/**
 * Shared syntax-highlighter setup.
 *
 * Uses `PrismLight` instead of the default `Prism` export from
 * react-syntax-highlighter — `Prism` eagerly bundles ~280 PrismJS language
 * definitions (~1MB minified), while `PrismLight` only ships languages we
 * explicitly register. This module is the single registration point so the
 * three call sites (markdown-inline, markdown-view, task-detail-tool-call)
 * share one configured highlighter.
 *
 * Add a language here when content using it appears in the UI; unregistered
 * languages render as plain text (no error, just no syntax colors).
 */

import {PrismLight as SyntaxHighlighter} from 'react-syntax-highlighter'
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff'
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown'
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

SyntaxHighlighter.registerLanguage('bash', bash)
SyntaxHighlighter.registerLanguage('css', css)
SyntaxHighlighter.registerLanguage('diff', diff)
SyntaxHighlighter.registerLanguage('go', go)
SyntaxHighlighter.registerLanguage('html', markup)
SyntaxHighlighter.registerLanguage('javascript', javascript)
SyntaxHighlighter.registerLanguage('js', javascript)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('jsx', jsx)
SyntaxHighlighter.registerLanguage('markdown', markdown)
SyntaxHighlighter.registerLanguage('markup', markup)
SyntaxHighlighter.registerLanguage('md', markdown)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('py', python)
SyntaxHighlighter.registerLanguage('rust', rust)
SyntaxHighlighter.registerLanguage('rs', rust)
SyntaxHighlighter.registerLanguage('sh', bash)
SyntaxHighlighter.registerLanguage('shell', bash)
SyntaxHighlighter.registerLanguage('sql', sql)
SyntaxHighlighter.registerLanguage('ts', typescript)
SyntaxHighlighter.registerLanguage('tsx', tsx)
SyntaxHighlighter.registerLanguage('typescript', typescript)
SyntaxHighlighter.registerLanguage('xml', markup)
SyntaxHighlighter.registerLanguage('yaml', yaml)
SyntaxHighlighter.registerLanguage('yml', yaml)

export {PrismLight as SyntaxHighlighter} from 'react-syntax-highlighter'
export {oneDark, oneLight} from 'react-syntax-highlighter/dist/esm/styles/prism'
