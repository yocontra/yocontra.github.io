import { glslFragment, glslVertex, wgsl } from './shaders.ts'

export type BackendKind = 'webgpu' | 'webgl2'

export interface Backend {
  kind: BackendKind
  /** Draw one frame with the packed uniforms. Canvas size is managed by the caller. */
  draw: (uniforms: Float32Array) => void
  destroy: () => void
}

export async function createWebGPU(canvas: HTMLCanvasElement): Promise<Backend | null> {
  if (!('gpu' in navigator)) {
    return null
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' })
  if (!adapter) {
    return null
  }
  const device = await adapter.requestDevice()
  const context = canvas.getContext('webgpu')
  if (!context) {
    device.destroy()
    return null
  }

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  const module = device.createShaderModule({ code: wgsl })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  })

  const buffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer } }],
  })

  return {
    kind: 'webgpu',
    draw(uniforms) {
      device.queue.writeBuffer(buffer, 0, uniforms.buffer, uniforms.byteOffset, uniforms.byteLength)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])
    },
    destroy() {
      buffer.destroy()
      context.unconfigure()
      device.destroy()
    },
  }
}

function compile(gl: WebGL2RenderingContext, type: GLenum, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('createShader failed')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed')
  }
  return shader
}

export function createWebGL2(canvas: HTMLCanvasElement): Backend | null {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    alpha: false,
    powerPreference: 'low-power',
  })
  if (!gl) {
    return null
  }

  const program = gl.createProgram()
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, glslVertex))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, glslFragment))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'program link failed')
  }
  const location = gl.getUniformLocation(program, 'U')
  const vao = gl.createVertexArray()

  return {
    kind: 'webgl2',
    draw(uniforms) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.useProgram(program)
      gl.uniform4fv(location, uniforms)
      gl.bindVertexArray(vao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    destroy() {
      gl.deleteProgram(program)
      gl.deleteVertexArray(vao)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
