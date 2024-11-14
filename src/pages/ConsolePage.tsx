// ConsolePage.tsx

import { useEffect, useRef, useCallback, useState } from 'react';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, Zap, ArrowUp, ArrowDown } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';
import { Map } from '../components/Map';

import './ConsolePage.scss';

import ReconnectingWebSocket from 'reconnecting-websocket';

/**
 * Type for result from get_weather() function call
 */
interface Coordinates {
  lat: number;
  lng: number;
  location?: string;
  temperature?: {
    value: number;
    units: string;
  };
  wind_speed?: {
    value: number;
    units: string;
  };
}

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

// Add helper function to decode Base64 to Int16Array
function base64ToInt16Array(base64: string): Int16Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export function ConsolePage() {
  /**
   * Instantiate:
   * - WavRecorder (speech input)
   * - WavStreamPlayer (speech output)
   * - WebSocket client to relay server
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );

  const wsRef = useRef<ReconnectingWebSocket | null>(null);

  /**
   * References for
   * - Rendering audio visualization (canvas)
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   */
  const [items, setItems] = useState<any[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});
  const [coords, setCoords] = useState<Coordinates | null>({
    lat: 37.775593,
    lng: -122.418137,
  });
  const [marker, setMarker] = useState<Coordinates | null>(null);

  // Add state to store audio chunks and blobs
  const [audioChunks, setAudioChunks] = useState<Int16Array[]>([]);
  const [audioBlobs, setAudioBlobs] = useState<{ [key: string]: Blob }>({});

  // Add state to store output audio chunks and blobs
  const [outputAudioChunks, setOutputAudioChunks] = useState<{ [key: string]: Int16Array[] }>({});
  const [outputAudioBlobs, setOutputAudioBlobs] = useState<{ [key: string]: Blob }>({});

  /**
   * Utility for formatting the timing of logs
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * Connect to relay server
   */
  const connectConversation = useCallback(async () => {
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Set state variables
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);

    // Connect to audio output
    await wavStreamPlayer.connect();

    // Connect to relay server
    const wsUrl = `${process.env.REACT_APP_LOCAL_RELAY_SERVER_URL}/ws`;
    const ws = new ReconnectingWebSocket(wsUrl);
    ws.binaryType = 'arraybuffer'; // Set binary type for audio data
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to relay server');
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const data = JSON.parse(event.data);
        // Handle events from relay server
        const realtimeEvent = {
          time: data.timestamp || new Date().toISOString(),
          source: 'server' as const,
          event: data,
        };
        setRealtimeEvents((prev) => [...prev, realtimeEvent]);

        // Handle conversation items
        if (data.item) {
          setItems((prevItems) => {
            const existingItemIndex = prevItems.findIndex(
              (item) => item.id === data.item.id
            );
            if (existingItemIndex !== -1) {
              const updatedItems = [...prevItems];
              updatedItems[existingItemIndex] = data.item;
              return updatedItems;
            } else {
              return [...prevItems, data.item];
            }
          });
        }

        // Handle audio playback with Base64 decoding
        if (data.delta?.audio && data.item?.id) {
          try {
            const audioData = base64ToInt16Array(data.delta.audio);
            wavStreamPlayer.add16BitPCM(audioData, data.item.id);

            // Store the audio data for playback
            setOutputAudioChunks((prevChunks) => {
              const chunks = prevChunks[data.item.id] || [];
              return {
                ...prevChunks,
                [data.item.id]: [...chunks, audioData],
              };
            });
          } catch (error) {
            console.error('Error processing audio data:', error);
          }
        }

        // Check if the audio is complete
        if (data.event === 'audio_complete' && data.item?.id) {
          const chunks = outputAudioChunks[data.item.id];
          if (chunks) {
            // Combine chunks into a single Int16Array
            const allAudioData = chunks.reduce((acc, chunk) => {
              const newData = new Int16Array(acc.length + chunk.length);
              newData.set(acc);
              newData.set(chunk, acc.length);
              return newData;
            }, new Int16Array());

            // Create a Blob from the audio data
            const audioBuffer = new ArrayBuffer(allAudioData.length * 2);
            const view = new DataView(audioBuffer);
            for (let i = 0; i < allAudioData.length; i++) {
              view.setInt16(i * 2, allAudioData[i], true);
            }
            const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });

            // Store the blob
            setOutputAudioBlobs((prevBlobs) => ({
              ...prevBlobs,
              [data.item.id]: audioBlob,
            }));

            // Add an event to realtimeEvents
            const audioEvent: RealtimeEvent = {
              time: new Date().toISOString(),
              source: 'server',
              event: {
                type: 'output_audio',
                audioBlobKey: data.item.id,
              },
            };
            setRealtimeEvents((prev) => [...prev, audioEvent]);

            // Remove the chunks
            setOutputAudioChunks((prevChunks) => {
              const updatedChunks = { ...prevChunks };
              delete updatedChunks[data.item.id];
              return updatedChunks;
            });
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        console.log('Received binary audio data from server');
        // Handle binary audio data if needed
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from relay server');
      setIsConnected(false);
    };

    // Send initial message to OpenAI via relay server
    const initialMessage = {
      type: 'conversation.item.create',
      item: {
        type: 'message', // Changed from 'user_message' to 'message'
        role: 'user', // Added 'role' here
        text: 'Hello!',
      },
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(initialMessage));
    };

    // Connect to microphone
    try {
      await wavRecorder.begin();
    } catch (error) {
      console.error('Error accessing microphone:', error);
    }
  }, []);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});
    setCoords({
      lat: 37.775593,
      lng: -122.418137,
    });
    setMarker(null);

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  /**
   * Start and stop recording
   */
  const startRecording = async () => {
    setIsRecording(true);
    setAudioChunks([]); // Reset audio chunks
    const wavRecorder = wavRecorderRef.current;
    try {
      await wavRecorder.record((data) => {
        if (!data || !data.mono || !data.mono.buffer) {
          console.error('Received undefined or invalid data from the recorder');
          return;
        }
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          // Send audio data as binary
          wsRef.current.send(data.mono.buffer);
          setAudioChunks((prevChunks) => [...prevChunks, new Int16Array(data.mono.buffer)]);

          // Add realtime event for visualization
          const realtimeEvent: RealtimeEvent = {
            time: new Date().toISOString(),
            source: 'client',
            event: {
              type: 'input_audio_buffer.append',
              audio: `[audio chunk: ${data.mono.buffer.byteLength} bytes]`
            }
          };
          setRealtimeEvents(prev => [...prev, realtimeEvent]);
        }
      });
    } catch (error) {
      console.error('Error starting recording:', error);
      setIsRecording(false);
    }
  };

  const stopRecording = async () => {
    setIsRecording(false);
    const wavRecorder = wavRecorderRef.current;
    if (wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const commitEvent = {
          type: 'audio_commit',
        };
        wsRef.current.send(JSON.stringify(commitEvent));

        // Reconstruct audio blob and store it
        const allAudioData = audioChunks.reduce((acc, chunk) => {
          const newData = new Int16Array(acc.length + chunk.length);
          newData.set(acc);
          newData.set(chunk, acc.length);
          return newData;
        }, new Int16Array());
        const audioBuffer = new ArrayBuffer(allAudioData.length * 2);
        const view = new DataView(audioBuffer);
        for (let i = 0; i < allAudioData.length; i++) {
          view.setInt16(i * 2, allAudioData[i], true);
        }
        const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });

        // Store the blob with a unique key
        const timestamp = Date.now().toString();
        setAudioBlobs((prevBlobs) => ({ ...prevBlobs, [timestamp]: audioBlob }));

        // Add an event to realtimeEvents
        const realtimeEvent: RealtimeEvent = {
          time: new Date().toISOString(),
          source: 'client',
          event: {
            type: 'audio_recording',
            audioBlobKey: timestamp,
          },
        };
        setRealtimeEvents((prev) => [...prev, realtimeEvent]);

        // Clear audio chunks
        setAudioChunks([]);
      }
    } else {
      console.warn('Recording was not started');
    }
  };

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const changeTurnEndType = (value: string) => {
    setCanPushToTalk(value === 'none');
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      // Update session with turn detection settings
      const sessionUpdate = {
        type: 'session.update',
        session: {
          turn_detection: value === 'none' ? null : { type: 'server_vad' },
        },
      };
      wsRef.current.send(JSON.stringify(sessionUpdate));
    }
  };

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * Set up render loops for the visualization canvas
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.getStatus() === 'recording'
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="/openai-logomark.svg" />
          <span>realtime console</span>
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="content-block events">
            <div className="visualization">
              <div className="visualization-entry client">
                <canvas ref={clientCanvasRef} />
              </div>
              <div className="visualization-entry server">
                <canvas ref={serverCanvasRef} />
              </div>
            </div>
            <div className="content-block-title">events</div>
            <div className="content-block-body" ref={eventsScrollRef}>
              {!realtimeEvents.length && `awaiting connection...`}
              {realtimeEvents.map((realtimeEvent, i) => {
                const count = realtimeEvent.count;
                const event = { ...realtimeEvent.event };
                if (event.type === 'input_audio_buffer.append') {
                  event.audio = `[trimmed: ${event.audio.length} bytes]`;
                } else if (event.type === 'response.audio.delta') {
                  event.delta = `[trimmed: ${event.delta.length} bytes]`;
                }
                return (
                  <div className="event" key={i}>
                    <div className="event-timestamp">
                      {formatTime(realtimeEvent.time)}
                    </div>
                    <div className="event-details">
                      <div
                        className="event-summary"
                        onClick={() => {
                          // toggle event details
                          const id = i.toString();
                          const expanded = { ...expandedEvents };
                          if (expanded[id]) {
                            delete expanded[id];
                          } else {
                            expanded[id] = true;
                          }
                          setExpandedEvents(expanded);
                        }}
                      >
                        <div
                          className={`event-source ${
                            event.type === 'error' ? 'error' : realtimeEvent.source
                          }`}
                        >
                          {realtimeEvent.source === 'client' ? (
                            <ArrowUp />
                          ) : (
                            <ArrowDown />
                          )}
                          <span>
                            {realtimeEvent.source === 'client'
                              ? 'client'
                              : 'server'}
                          </span>
                        </div>
                        <div className="event-type">
                          {event.type}
                          {count && ` (${count})`}
                        </div>
                      </div>
                      {!!expandedEvents[i.toString()] && (
                        <div className="event-payload">
                          {event.type === 'audio_recording' &&
                          audioBlobs[event.audioBlobKey] ? (
                            <audio
                              controls
                              src={URL.createObjectURL(
                                audioBlobs[event.audioBlobKey]
                              )}
                            />
                          ) : event.type === 'output_audio' && outputAudioBlobs[event.audioBlobKey] ? (
                            <audio
                              controls
                              src={URL.createObjectURL(outputAudioBlobs[event.audioBlobKey])}
                            />
                          ) : (
                            <div>{JSON.stringify(event, null, 2)}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-block conversation">
            <div className="content-block-title">conversation</div>
            <div className="content-block-body" data-conversation-content>
              {!items.length && `awaiting connection...`}
              {items.map((conversationItem, i) => {
                return (
                  <div className="conversation-item" key={conversationItem.id}>
                    <div className={`speaker ${conversationItem.role || ''}`}>
                      <div>
                        {(conversationItem.role || conversationItem.type).replaceAll(
                          '_',
                          ' '
                        )}
                      </div>
                    </div>
                    <div className={`speaker-content`}>
                      {conversationItem.text && <div>{conversationItem.text}</div>}
                      {conversationItem.output && (
                        <div>{conversationItem.output}</div>
                      )}
                      {conversationItem.arguments && (
                        <div>
                          {conversationItem.name}({conversationItem.arguments})
                        </div>
                      )}
                      {conversationItem.audio && (
                        <audio
                          src={`data:audio/wav;base64,${conversationItem.audio}`}
                          controls
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-actions">
            <Toggle
              defaultValue={false}
              labels={['manual', 'vad']}
              values={['none', 'server_vad']}
              onChange={(_, value) => changeTurnEndType(value)}
            />
            <div className="spacer" />
            {isConnected && canPushToTalk && (
              <Button
                label={isRecording ? 'release to send' : 'push to talk'}
                buttonStyle={isRecording ? 'alert' : 'regular'}
                disabled={!isConnected || !canPushToTalk}
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
              />
            )}
            <div className="spacer" />
            <Button
              label={isConnected ? 'disconnect' : 'connect'}
              iconPosition={isConnected ? 'end' : 'start'}
              icon={isConnected ? X : Zap}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={
                isConnected ? disconnectConversation : connectConversation
              }
            />
          </div>
        </div>
        <div className="content-right">
          <div className="content-block map">
            <div className="content-block-title">get_weather()</div>
            <div className="content-block-title bottom">
              {marker?.location || 'not yet retrieved'}
              {!!marker?.temperature && (
                <>
                  <br />
                  🌡️ {marker.temperature.value} {marker.temperature.units}
                </>
              )}
              {!!marker?.wind_speed && (
                <>
                  {' '}
                  🍃 {marker.wind_speed.value} {marker.wind_speed.units}
                </>
              )}
            </div>
            <div className="content-block-body full">
              {coords && (
                <Map
                  center={[coords.lat, coords.lng]}
                  location={coords.location}
                />
              )}
            </div>
          </div>
          <div className="content-block kv">
            <div className="content-block-title">set_memory()</div>
            <div className="content-block-body content-kv">
              {JSON.stringify(memoryKv, null, 2)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
