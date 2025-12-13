/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CompileOptions } from 'google-closure-compiler';
import { promises as fsPromises } from 'fs';
import { createFilter, FilterPattern } from '@rollup/pluginutils';
import { OutputOptions, Plugin, InputOptions, PluginContext, RenderedChunk, TransformResult } from 'rollup';
import compiler from './compiler';
import options from './options';
import { transform as sourceTransform, create as createSourceTransforms } from './transformers/source/transforms';
import { preCompilation, create as createChunkTransforms } from './transformers/chunk/transforms';
import { Mangle } from './transformers/mangle';
import { Ebbinghaus } from './transformers/ebbinghaus';
import { SourceTransform } from './transform';

// Interface estendida para aceitar include/exclude junto com as opções do compilador
type ClosurePluginOptions = CompileOptions & {
  include?: FilterPattern;
  exclude?: FilterPattern;
};

export default function closureCompiler(pluginOptions: ClosurePluginOptions = {}): Plugin {
  // Separa as opções de filtro das opções do compilador
  const { include, exclude, ...requestedCompileOptions } = pluginOptions;

  // Cria a função de filtro
  const filter = createFilter(include, exclude);

  const mangler: Mangle = new Mangle();
  const memory: Ebbinghaus = new Ebbinghaus();
  let inputOptions: InputOptions;
  let context: PluginContext;
  let sourceTransforms: Array<SourceTransform>;

  return {
    name: 'closure-compiler',
    options: (options) => (inputOptions = options),
    buildStart() {
      context = this;
      sourceTransforms = createSourceTransforms(context, requestedCompileOptions, mangler, memory, inputOptions, {});
      if (
        'compilation_level' in requestedCompileOptions &&
        requestedCompileOptions.compilation_level === 'ADVANCED_OPTIMIZATIONS' &&
        Array.isArray(inputOptions.input)
      ) {
        context.warn('Code Splitting with Closure Compiler ADVANCED_OPTIMIZATIONS is not currently supported.');
      }
    },
    transform: async (code: string, id: string): Promise<TransformResult> => {
      // 1. Aplica o filtro (exclude/include)
      if (!filter(id)) {
        return null;
      }

      // 2. Proteção contra erros de parsing do Acorn (Opção 2)
      try {
        if (sourceTransforms.length > 0) {
          const output = await sourceTransform(code, id, sourceTransforms);
          return output || null;
        }
      } catch (e) {
        // Se falhar a transformação preliminar (erro de sintaxe no parser do plugin),
        // retornamos null para usar o código original sem quebrar o build.
        // Opcional: context.warn(`[closure-compiler] Skipping transform for ${id}: ${e.message}`);
        return null;
      }
      return null;
    },
    renderChunk: async (code: string, chunk: RenderedChunk, outputOptions: OutputOptions) => {
      if (!filter(chunk.fileName)) {
        return null;
      }

      mangler.debug();

      try {
        const renderChunkTransforms = createChunkTransforms(
          context,
          requestedCompileOptions,
          mangler,
          memory,
          inputOptions,
          outputOptions,
        );

        let preCompileOutput = code;
        try {
          const result = await preCompilation(code, chunk, renderChunkTransforms);
          preCompileOutput = result.code;
        } catch (e) {
          preCompileOutput = code;
        }

        const [compileOptions, mapFile] = await options(
          requestedCompileOptions,
          outputOptions,
          preCompileOutput,
          renderChunkTransforms,
        );

        return {
          code: await compiler(compileOptions, chunk, renderChunkTransforms),
          map: JSON.parse(await fsPromises.readFile(mapFile, 'utf8')),
        };
      } catch (error) {
        return null;
      }
    },
  };
}
