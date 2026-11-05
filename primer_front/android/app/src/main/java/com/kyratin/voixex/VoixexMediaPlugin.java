package com.kyratin.voixex;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Transports encrypted media envelopes only; camera/microphone remain owned by the WebView. */
@CapacitorPlugin(name = "VoixexMedia")
public class VoixexMediaPlugin extends Plugin {
    private final ConcurrentHashMap<String, Connection> connections = new ConcurrentHashMap<>();
    private final ExecutorService opener = Executors.newCachedThreadPool();

    private class Connection {
        final String id;
        volatile boolean closed;
        volatile DatagramSocket udp;
        volatile Socket tcp;
        DataOutputStream output;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        Connection(String id) { this.id = id; }
        void shutdown() {
            if (closed) return;
            closed = true;
            connections.remove(id, this);
            if (udp != null) udp.close();
            try { if (tcp != null) tcp.close(); } catch (IOException ignored) {}
            writer.shutdown();
            JSObject event = new JSObject(); event.put("id", id);
            notifyListeners("closed", event);
        }
        void packet(byte[] bytes, int size) {
            if (closed) return;
            JSObject event = new JSObject(); event.put("id", id);
            event.put("data", Base64.encodeToString(bytes, 0, size, Base64.NO_WRAP));
            notifyListeners("packet", event);
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id"), host = call.getString("host"), transport = call.getString("transport");
        Integer port = call.getInt("port");
        if (id == null || host == null || host.isEmpty() || port == null || port < 1 || port > 65535 || !("udp".equals(transport) || "tcp".equals(transport))) {
            call.reject("Invalid media endpoint"); return;
        }
        if (connections.size() >= 4) { call.reject("Too many media connections"); return; }
        Connection connection = new Connection(id);
        if (connections.putIfAbsent(id, connection) != null) { call.reject("Connection already exists"); return; }
        opener.execute(() -> {
            try {
                InetSocketAddress address = new InetSocketAddress(host, port);
                if (connection.closed) throw new IOException("Connection closed");
                if ("udp".equals(transport)) {
                    DatagramSocket socket = new DatagramSocket();
                    connection.udp = socket;
                    socket.connect(address);
                    if (connection.closed) { socket.close(); throw new IOException("Connection closed"); }
                    call.resolve();
                    byte[] bytes = new byte[65536];
                    while (!connection.closed) {
                        DatagramPacket packet = new DatagramPacket(bytes, bytes.length);
                        socket.receive(packet);
                        connection.packet(bytes, packet.getLength());
                    }
                } else {
                    Socket socket = new Socket();
                    connection.tcp = socket;
                    socket.connect(address, 6000);
                    socket.setTcpNoDelay(true);
                    if (connection.closed) { socket.close(); throw new IOException("Connection closed"); }
                    connection.output = new DataOutputStream(socket.getOutputStream());
                    DataInputStream input = new DataInputStream(socket.getInputStream());
                    call.resolve();
                    while (!connection.closed) {
                        int length = input.readInt();
                        if (length < 1 || length > 65536) throw new IOException("Invalid media frame length");
                        byte[] bytes = new byte[length]; input.readFully(bytes);
                        connection.packet(bytes, length);
                    }
                }
            } catch (Exception error) {
                // A resolved open reports later failures through the closed event.
                if (connection.udp == null && connection.output == null) call.reject("Could not open media socket", error);
            } finally { connection.shutdown(); }
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        Connection connection = connections.get(call.getString("id", ""));
        String encoded = call.getString("data", "");
        if (connection == null || connection.closed || encoded.length() > 87384) { call.reject("Media connection unavailable"); return; }
        final byte[] data;
        try { data = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException error) { call.reject("Invalid media packet"); return; }
        if (data.length == 0 || data.length > 65536) { call.reject("Invalid media packet size"); return; }
        try {
            connection.writer.execute(() -> {
                try {
                    if (connection.closed) throw new IOException("Connection closed");
                    if (connection.udp != null) connection.udp.send(new DatagramPacket(data, data.length));
                    else { connection.output.writeInt(data.length); connection.output.write(data); connection.output.flush(); }
                    call.resolve();
                } catch (Exception error) { call.reject("Media send failed", error); connection.shutdown(); }
            });
        } catch (RuntimeException error) { call.reject("Media connection closed", error); }
    }

    @PluginMethod
    public void close(PluginCall call) {
        Connection connection = connections.get(call.getString("id", ""));
        if (connection != null) connection.shutdown();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Connection connection : connections.values()) connection.shutdown();
        opener.shutdownNow();
    }
}
